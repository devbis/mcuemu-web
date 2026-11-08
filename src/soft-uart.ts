export class SoftUartDecoder {
  private currentLevel = true;
  private frame?: { samples: boolean[]; nextSampleNs: number; bitPeriodNs: number };

  constructor(private readonly baud: number) {
    if (!Number.isFinite(baud) || baud < 1 || baud > 1_000_000) throw new Error('Soft UART baud must be 1..1000000.');
  }

  feed(timeNs: number, high: boolean): number[] {
    const bytes = this.advance(timeNs);
    if (this.currentLevel && !high && !this.frame) {
      const bitPeriodNs = 1_000_000_000 / this.baud;
      this.frame = { samples: [], nextSampleNs: timeNs + bitPeriodNs / 2, bitPeriodNs };
    }
    this.currentLevel = high;
    return bytes;
  }

  advance(timeNs: number): number[] {
    const bytes: number[] = [];
    while (this.frame && this.frame.nextSampleNs <= timeNs) {
      this.frame.samples.push(this.currentLevel);
      if (this.frame.samples.length === 10) {
        const samples = this.frame.samples;
        if (!samples[0] && samples[9]) {
          let value = 0;
          for (let bit = 0; bit < 8; bit += 1) if (samples[bit + 1]) value |= 1 << bit;
          bytes.push(value);
        }
        this.frame = undefined;
      } else {
        this.frame.nextSampleNs += this.frame.bitPeriodNs;
      }
    }
    return bytes;
  }

  reset(level = true): void {
    this.currentLevel = level;
    this.frame = undefined;
  }
}
