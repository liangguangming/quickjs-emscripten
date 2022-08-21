import { EitherModule } from "./emscripten-types"
import {
  OwnedHeapCharPointer,
  JSContextPointerPointer,
  JSValueConstPointerPointer,
  JSValuePointerPointer,
} from "./types-ffi"
import { Lifetime } from "./lifetime"
import { EitherFFI, QuickJSHandle } from "./types"

/**
 * @private
 */
export class ModuleMemory {
  constructor(public module: EitherModule) {}

  toPointerArray(handleArray: QuickJSHandle[]): Lifetime<JSValueConstPointerPointer> {
    const typedArray = new Int32Array(handleArray.map((handle) => handle.value))
    const numBytes = typedArray.length * typedArray.BYTES_PER_ELEMENT
    const ptr = this.module._malloc(numBytes) as JSValueConstPointerPointer
    var heapBytes = new Uint8Array(this.module.HEAPU8.buffer, ptr, numBytes)
    heapBytes.set(new Uint8Array(typedArray.buffer))
    return new Lifetime(ptr, undefined, (ptr) => this.module._free(ptr))
  }

  newMutablePointerArray<T extends JSContextPointerPointer | JSValuePointerPointer>(
    length: number
  ): Lifetime<{ typedArray: Int32Array; ptr: T }> {
    const zeros = new Int32Array(new Array(length).fill(0))
    const numBytes = zeros.length * zeros.BYTES_PER_ELEMENT
    const ptr = this.module._malloc(numBytes) as T
    const typedArray = new Int32Array(this.module.HEAPU8.buffer, ptr, length)
    typedArray.set(zeros)
    return new Lifetime({ typedArray, ptr }, undefined, (value) => this.module._free(value.ptr))
  }

  stringToUTF16(str: string) {
    const numBytes = 4 + 2 * str.length
    const ptr = this.module._malloc(numBytes);

    this.module.HEAPU32[ptr >> 2] = str.length;

    let startPtr: number = (ptr + 4) >> 1;
    for (let i = 0; i < str.length; i++) {
      this.module.HEAPU16[startPtr + i] = str.charCodeAt(i);
    }
    return ptr;
  }

  UTF16ToString(ptr: number) {
    const length = this.module.HEAPU32[ptr >> 2];
    let str = "";
    let startPtr: number = (ptr + 4) >> 1;
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.module.HEAPU16[startPtr + i]);
    }

    return str;
  }

  stringToUTF8(str: string) {
    const numBytes = this.module.lengthBytesUTF8(str) + 4 + 1;
    const ptr = this.module._malloc(numBytes);

    this.module.HEAP32[ptr >> 2] = str.length;

    function stringToUTF8Array(str: string, heap: Uint8Array, outIdx: number, maxBytesToWrite: number) {
      if (!(maxBytesToWrite > 0)) // Parameter maxBytesToWrite is not optional. Negative values, 0, null, undefined and false each don't write out any bytes.
        return 0;
    
      var startIdx = outIdx;
      var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
      for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
        var u = str.charCodeAt(i); // possibly a lead surrogate
        if (u >= 0xD800 && u <= 0xDFFF) {
          var u1 = str.charCodeAt(++i);
          u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
        }
        if (u <= 0x7F) {
          if (outIdx >= endIdx) break;
          heap[outIdx++] = u;
        } else if (u <= 0x7FF) {
          if (outIdx + 1 >= endIdx) break;
          heap[outIdx++] = 0xC0 | (u >> 6);
          heap[outIdx++] = 0x80 | (u & 63);
        } else if (u <= 0xFFFF) {
          if (outIdx + 2 >= endIdx) break;
          heap[outIdx++] = 0xE0 | (u >> 12);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
        } else {
          if (outIdx + 3 >= endIdx) break;
          if (u > 0x10FFFF) console.warn('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).');
          heap[outIdx++] = 0xF0 | (u >> 18);
          heap[outIdx++] = 0x80 | ((u >> 12) & 63);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
        }
      }
      // Null-terminate the pointer to the buffer.
      heap[outIdx] = 0;
      return outIdx - startIdx;
    }
    stringToUTF8Array(str, this.module.HEAPU8 , ptr + 4, numBytes - 4);

    return ptr;
  }

  UTF8ToString(ptr: number) {
    if (!ptr) {
      return "";
    }
    var UTF8Decoder = typeof TextDecoder != 'undefined' ? new TextDecoder('utf8') : undefined;
    let length = this.module.HEAP32[ptr >> 2];

    let idx = ptr + 4;
    var endPtr = idx + length;
    const heap = this.module.HEAPU8;
    if (length > 16 && heap.subarray && UTF8Decoder) {
      return UTF8Decoder.decode(heap.subarray(ptr + 4, endPtr));
    } else {
      var str = '';
      while (idx < endPtr) {
        var u0 = heap[idx++];
        if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
        var u1 = heap[idx++] & 63;
        if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
        var u2 = heap[idx++] & 63;
        if ((u0 & 0xF0) == 0xE0) {
          u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {
          if ((u0 & 0xF8) != 0xF0) console.warn('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string in wasm memory to a JS string!');
          u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heap[idx++] & 63);
        }

        if (u0 < 0x10000) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 0x10000;
          str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        }
      }
    }
    return str;
  }

  newHeapCharPointer(string: string): Lifetime<OwnedHeapCharPointer> {
    const numBytes = this.module.lengthBytesUTF8(string) + 1
    const ptr: OwnedHeapCharPointer = this.module._malloc(numBytes) as OwnedHeapCharPointer
    this.module.stringToUTF8(string, ptr, numBytes)
    return new Lifetime(ptr, undefined, (value) => this.module._free(value))
  }

  consumeHeapCharPointer(ptr: OwnedHeapCharPointer): string {
    const str = this.module.UTF8ToString(ptr)
    this.module._free(ptr)
    return str
  }
}
