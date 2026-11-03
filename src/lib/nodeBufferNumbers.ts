/** Numeric reads over local byte copies never require a Node round trip. */
export function installNodeBufferReaders(prototype: object): void {
  function offsetFor(bytes: Uint8Array, offset: unknown, width: number): number {
    const value = offset === undefined ? 0 : offset;
    let code: string | undefined;
    if (typeof value !== "number") code = "ERR_INVALID_ARG_TYPE";
    else if (Math.floor(value) !== value) code = "ERR_OUT_OF_RANGE";
    else if (bytes.byteLength < width) code = "ERR_BUFFER_OUT_OF_BOUNDS";
    else if (value < 0 || value > bytes.byteLength - width) code = "ERR_OUT_OF_RANGE";
    if (code) {
      const error = code === "ERR_INVALID_ARG_TYPE"
        ? new TypeError('The "offset" argument must be of type number')
        : new RangeError(code === "ERR_BUFFER_OUT_OF_BOUNDS" ? "Attempt to access memory outside buffer bounds" : 'The value of "offset" is out of range');
      Object.assign(error, { code });
      throw error;
    }
    return value as number;
  }
  const definitions: [string, keyof DataView, number][] = [
    ["UInt8", "getUint8", 1], ["Int8", "getInt8", 1],
    ["UInt16", "getUint16", 2], ["Int16", "getInt16", 2],
    ["UInt32", "getUint32", 4], ["Int32", "getInt32", 4],
    ["Float", "getFloat32", 4], ["Double", "getFloat64", 8],
    ["BigUInt64", "getBigUint64", 8], ["BigInt64", "getBigInt64", 8],
  ];
  for (const [name, getter, width] of definitions) {
    for (const suffix of width === 1 ? [""] : ["LE", "BE"]) {
      const read = function (this: Uint8Array, offset?: number): number | bigint {
        const position = offsetFor(this, offset, width);
        const view = new DataView(this.buffer, this.byteOffset, this.byteLength);
        return (view[getter] as Function).call(view, position, suffix === "LE");
      };
      const aliases = name.startsWith("UInt") || name.startsWith("BigUInt")
        ? [name, name.replace("UInt", "Uint")] : [name];
      for (const alias of aliases) Object.defineProperty(prototype, `read${alias}${suffix}`, {
        value: read, writable: true, configurable: true, enumerable: true,
      });
    }
  }
}
