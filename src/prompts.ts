import { Writable } from "node:stream"
import { createInterface, type Interface } from "node:readline/promises"

class MuteableOutput extends Writable {
  muted = false

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk, encoding)
    callback()
  }
}

export class Prompts {
  private readonly output = new MuteableOutput()
  private readonly readline: Interface

  constructor() {
    this.readline = createInterface({ input: process.stdin, output: this.output, terminal: process.stdin.isTTY })
  }

  close(): void {
    this.readline.close()
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ""
    const value = (await this.readline.question(`${message}${suffix}: `)).trim()
    return value || defaultValue || ""
  }

  async secret(message: string): Promise<string> {
    if (!process.stdin.isTTY) return (await this.readline.question(`${message}: `)).trim()
    process.stdout.write(`${message}: `)
    this.output.muted = true
    try {
      return (await this.readline.question("")).trim()
    } finally {
      this.output.muted = false
      process.stdout.write("\n")
    }
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N"
    while (true) {
      const answer = (await this.readline.question(`${message} [${hint}]: `)).trim().toLowerCase()
      if (!answer) return defaultValue
      if (answer === "y" || answer === "yes") return true
      if (answer === "n" || answer === "no") return false
      process.stdout.write("Enter y or n.\n")
    }
  }

  async select(message: string, options: string[], defaultIndex = 0): Promise<number> {
    process.stdout.write(`${message}\n`)
    options.forEach((option, index) => process.stdout.write(`  ${index + 1}. ${option}\n`))
    while (true) {
      const answer = await this.text("Choice", String(defaultIndex + 1))
      const selected = Number(answer) - 1
      if (Number.isInteger(selected) && selected >= 0 && selected < options.length) return selected
      process.stdout.write(`Enter a number from 1 to ${options.length}.\n`)
    }
  }
}
