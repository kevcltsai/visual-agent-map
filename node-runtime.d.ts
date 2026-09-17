declare module "node:child_process" {
  export interface VisualAgentChunk {
    toString(encoding?: string): string;
  }

  export interface VisualAgentReadable {
    on(event: "data", listener: (chunk: VisualAgentChunk) => void): this;
  }

  export interface VisualAgentWritable {
    write(data: string): void;
    end(data?: string): void;
  }

  export interface VisualAgentChildProcess {
    stdout: VisualAgentReadable;
    stderr: VisualAgentReadable;
    stdin: VisualAgentWritable;
    kill(): boolean;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number | null) => void): this;
  }

  export function spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string; stdio: readonly ["pipe", "pipe", "pipe"] }
  ): VisualAgentChildProcess;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}
