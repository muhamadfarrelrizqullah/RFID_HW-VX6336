export class SerialTransport {
    constructor() {
        this.port = null;
        this.reader = null;
    }
    
    getDeviceInfo() {
        if (!this.port) {
            console.error("Port is not initialized.");
            return null;
        }
        const { usbVendorId, usbProductId } = this.port.getInfo();
        const deviceName = `Vendor ID: ${usbVendorId}, Product ID: ${usbProductId}`;
        return deviceName;
    }
    
    async open(baudRate = 57600, bufferSize = 1024) {
        // You can set filter if need it
        // { usbVendorId: 4292, usbProductId: 60000 } just for HW-VX6336 reader
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
            this.port = ports[0];
            console.log("Using previously authorized port.");
        } else {
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 4292, usbProductId: 60000 }]
            });
            console.log("Requesting new port.");
        }
        // this.port = await navigator.serial.requestPort();
        await this.port.open({ baudRate, bufferSize });
        this.reader = this.port.readable?.getReader({ mode: "byob" });
        console.log("Port opened successfully.");
    }
    
    async close() {
        if (!this.port) {
            return;
        }
        
        if (this.reader) {
            await this.reader.releaseLock();
        }
        
        await this.port?.close();
        console.log("Port closed successfully.");
    }
    
    async clear() {
        if (!this.reader) {
            console.error("Reader is not initialized.");
            return;
        }
        
        try {
            const controller = new AbortController();
            const signal = controller.signal;
            
            // Set a timeout to abort the read operation after 100ms (adjust as needed)
            const timeoutId = setTimeout(() => {
                controller.abort(); // Abort the read operation
                console.log("Clear operation timed out, moving on...");
            }, 100);
            
            // Attempt to read from the port
            const { value: bytes } = await this.reader.read(new Uint8Array(1024), { signal });
            
            // Clear the timeout if read is successful or times out
            clearTimeout(timeoutId);
            
            if (!bytes || bytes.length === 0) {
                console.log("No data in buffer, clearing completed.");
                return;
            }
            
            // Log the cleared data if any
            console.log("Buffer cleared:", bytes);
        } catch (error) {
            if (error.name === 'AbortError') {
                // This means the read operation was aborted due to timeout
                console.log("Clear operation aborted due to timeout, moving on...");
            } else {
                // Log other errors
                console.error("Error during buffer clear:", error);
            }
        }
    }

    async read(size) {
        if (!this.reader) {
            console.error("Reader is not initialized.");
            return null;
        }
        
        try {
            const controller = new AbortController();
            const signal = controller.signal;
            
            // Set a timeout to abort the read operation
            const timeoutId = setTimeout(() => {
                controller.abort();
                console.error("Read operation timed out.");
            }, 1000);
            
            const { value: bytes } = await this.reader.read(new Uint8Array(size), { signal });
            clearTimeout(timeoutId); // Clear timeout if read is successful
            return bytes;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.error("Read operation was aborted due to timeout.");
            } else {
                console.error("Error during read:", error);
            }
            return null;
        }
    }

    async write(data) {
        try {
            const writer = this.port?.writable?.getWriter();
            if (!writer) {
                console.error("Unable to write: Port not writable.");
                return;
            }
            
            await writer.write(data);
            await writer.close();
        } catch (error) {
            console.error("Error during write:", error);
        }
    }
}

export class Reader {
    constructor(transport) {
        this.transport = transport;
    }
    
    // Please refer to protocol documentation, how data bytes are read and parsed.
    // This is using the HW-VX series reader.
    async inventoryAnswerMode() {
        try {
            // Send Inventory, please check the documentation
            const inventoryCommand = new Uint8Array([0x04, 0xFF, 0x01, 0x1B, 0xB4]);
            await this.transport.write(inventoryCommand);
            
            // Read first byte to get the length of next bytes
            const firstByte = await this.transport.read(1);
            const byteLength = firstByte?.[0];
            
            if (!byteLength) {
                console.error("Invalid first byte length.");
                return null;
            }
            if (byteLength == 0) {
                return null;
            }
            
            // Read additional bytes as indicated by the first byte
            const dataBytes = await this.transport.read(byteLength);
            
            if (!dataBytes) {
                console.error("Failed to read additional bytes.");
                return null;
            }
            
            // Combine first byte and the additional bytes
            const frame = new Uint8Array(firstByte.byteLength + dataBytes.byteLength);
            frame.set(firstByte);
            frame.set(dataBytes, firstByte.byteLength);
            
            // Parse to Response class
            const response = new Response(frame);
            if (!response.validateChecksum()) {
                console.log("Checksum is not valid!");
                console.log("Clearing buffer...");
                await this.transport.clear();
                console.log("Buffer cleared. Proceeding...");
                return [];
            }
            
            const data = response.data;
            
            if (data.length === 0) {
                return [];
            }
            
            const tags = [];
            const tagCount = data[0]; // The first byte indicates the number of tags
            
            console.log("Tag count: " + tagCount);
            
            let n = 0;
            let pointer = 1; // Start reading after the tagCount byte
            
            while (n < tagCount) {
                const tagLen = data[pointer]; // Length of the tag
                const tagDataStart = pointer + 1; // Start of the tag data
                const tagMainStart = tagDataStart; // Start of the main tag
                const tagMainEnd = tagMainStart + tagLen; // End of the main tag
                const nextTagStart = tagMainEnd; // Start of the next tag
                
                // Create a new Uint8Array for the tag
                const tag = new Uint8Array([
                    ...data.subarray(tagDataStart, tagMainStart),
                    ...data.subarray(tagMainStart, tagMainEnd),
                    ...data.subarray(nextTagStart, nextTagStart)
                ]);
                
                if (tag.length == 0) {
                    break;
                }
                
                tags.push(tag); // Add the tag to the list
                
                console.log("Tag ke-" + (n + 1) + ": " + Array.from(tag)
                    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
                    .join(' '));
                
                pointer = nextTagStart; // Move the pointer to the next tag
                n += 1; // Increment the tag count
            }
            
            return tags;
        } catch (error) {
            console.error("Error in inventoryAnswerMode:", error);
            return null;
        }
    }
}

class Response {
    constructor(responseBytes) {
        if (!(responseBytes instanceof Uint8Array)) {
            throw new TypeError("Expected responseBytes to be an instance of Uint8Array.");
        }
        
        this.responseBytes = responseBytes;
        this.length = responseBytes[0];
        this.readerAddress = responseBytes[1];
        this.command = responseBytes[2];
        this.status = responseBytes[3];
        this.data = responseBytes.slice(4, -2);
        this.checksum = responseBytes.slice(-2);
    }
    
    getChecksumValue() {
        return (this.checksum[1] << 8) | this.checksum[0];
    }
    
    validateChecksum() {
        const calculatedChecksum = this.calculateChecksum(this.responseBytes.slice(0, -2));
        return this.getChecksumValue() === calculatedChecksum;
    }
    
    calculateChecksum(data) {
        let value = 0xFFFF;
        
        for (let byte of data) {
            value ^= byte;
            
            for (let i = 0; i < 8; i++) {
                value = (value & 0x0001) !== 0 ? (value >> 1) ^ 0x8408 : value >> 1;
            }
        }
        
        return value;
    }
}