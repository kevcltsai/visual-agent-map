import { StringDecoder } from "node:string_decoder";

interface TextChunk {
  toString(encoding?: string): string;
}

/** Decodes one child-process stream. A multi-byte character split across chunks is held until its bytes arrive. */
export function createUtf8StreamDecoder(): { write(chunk: TextChunk): string; end(): string } {
  const decoder = new StringDecoder("utf8");
  return {
    write: chunk => (ArrayBuffer.isView(chunk) ? decoder.write(chunk as unknown as Buffer) : chunk.toString("utf8")),
    end: () => decoder.end()
  };
}
