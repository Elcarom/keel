const SCALE_DECIMALS = 8;
const SCALE_FACTOR = 100_000_000n;

export type TickRoundMode = "floor" | "ceil" | "nearest";

/**
 * Exact fixed-point decimal value object backed by an 8-decimal-place scaled bigint.
 * Forbids raw IEEE-754 floating-point arithmetic on the money/quantity path (ADR-0008).
 */
export class ScaledDecimal {
  private readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  public static zero(): ScaledDecimal {
    return new ScaledDecimal(0n);
  }

  public static fromScaledBigInt(raw: bigint): ScaledDecimal {
    return new ScaledDecimal(raw);
  }

  public static fromString(input: string): ScaledDecimal {
    const trimmed = input.trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid ScaledDecimal string: "${input}"`);
    }
    const isNegative = trimmed.startsWith("-");
    const unsigned = trimmed.replace(/^[+-]/, "");
    const [wholePart = "0", fracPart = ""] = unsigned.split(".");
    if (fracPart.length > SCALE_DECIMALS) {
      throw new Error(`ScaledDecimal precision exceeds ${SCALE_DECIMALS} decimals: "${input}"`);
    }
    const paddedFrac = fracPart.padEnd(SCALE_DECIMALS, "0");
    const combined = BigInt(wholePart) * SCALE_FACTOR + BigInt(paddedFrac);
    return new ScaledDecimal(isNegative ? -combined : combined);
  }

  public toScaledBigInt(): bigint {
    return this.raw;
  }

  public add(other: ScaledDecimal): ScaledDecimal {
    return new ScaledDecimal(this.raw + other.raw);
  }

  public sub(other: ScaledDecimal): ScaledDecimal {
    return new ScaledDecimal(this.raw - other.raw);
  }

  public abs(): ScaledDecimal {
    return new ScaledDecimal(this.raw < 0n ? -this.raw : this.raw);
  }

  /**
   * Multiplies two ScaledDecimals and truncates towards zero at 8 decimal places.
   */
  public mul(other: ScaledDecimal): ScaledDecimal {
    return new ScaledDecimal((this.raw * other.raw) / SCALE_FACTOR);
  }

  /**
   * Divides this by divisor, flooring towards negative infinity at 8 decimal places.
   */
  public divFloor(divisor: ScaledDecimal): ScaledDecimal {
    if (divisor.raw === 0n) {
      throw new Error("Division by zero in ScaledDecimal");
    }
    const numerator = this.raw * SCALE_FACTOR;
    const quotient = numerator / divisor.raw;
    const remainder = numerator % divisor.raw;
    if (remainder !== 0n && numerator < 0n !== divisor.raw < 0n) {
      return new ScaledDecimal(quotient - 1n);
    }
    return new ScaledDecimal(quotient);
  }

  /**
   * Rounds down (floor) to an integer multiple of `lotSize` (used for exchange contract lot sizing).
   */
  public roundDownToLot(lotSize: ScaledDecimal): ScaledDecimal {
    if (lotSize.raw <= 0n) {
      throw new Error("Lot size must be strictly positive");
    }
    if (this.raw < 0n) {
      throw new Error("roundDownToLot requires a non-negative value");
    }
    const lots = this.raw / lotSize.raw;
    return new ScaledDecimal(lots * lotSize.raw);
  }

  /**
   * Alias for `roundDownToLot` for general step increments.
   */
  public roundDownToStep(step: ScaledDecimal): ScaledDecimal {
    return this.roundDownToLot(step);
  }

  /**
   * Rounds a price to an exchange tick increment using explicit floor/ceil/nearest semantics.
   */
  public roundToTick(tickSize: ScaledDecimal, mode: TickRoundMode): ScaledDecimal {
    if (tickSize.raw <= 0n) {
      throw new Error("Tick size must be strictly positive");
    }
    if (this.raw < 0n) {
      throw new Error("Price cannot be negative when rounding to tick");
    }
    const quotient = this.raw / tickSize.raw;
    const remainder = this.raw % tickSize.raw;
    if (remainder === 0n) {
      return this;
    }
    if (mode === "floor") {
      return new ScaledDecimal(quotient * tickSize.raw);
    }
    if (mode === "ceil") {
      return new ScaledDecimal((quotient + 1n) * tickSize.raw);
    }
    const twiceRemainder = remainder * 2n;
    return new ScaledDecimal(
      twiceRemainder >= tickSize.raw ? (quotient + 1n) * tickSize.raw : quotient * tickSize.raw
    );
  }

  public equals(other: ScaledDecimal): boolean {
    return this.raw === other.raw;
  }

  public gt(other: ScaledDecimal): boolean {
    return this.raw > other.raw;
  }

  public gte(other: ScaledDecimal): boolean {
    return this.raw >= other.raw;
  }

  public lt(other: ScaledDecimal): boolean {
    return this.raw < other.raw;
  }

  public lte(other: ScaledDecimal): boolean {
    return this.raw <= other.raw;
  }

  public isPositive(): boolean {
    return this.raw > 0n;
  }

  public isZero(): boolean {
    return this.raw === 0n;
  }

  public static min(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
    return a.raw <= b.raw ? a : b;
  }

  public static max(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
    return a.raw >= b.raw ? a : b;
  }

  public toString(): string {
    if (this.raw === 0n) {
      return "0";
    }
    const isNegative = this.raw < 0n;
    const absRaw = isNegative ? -this.raw : this.raw;
    const whole = absRaw / SCALE_FACTOR;
    const frac = absRaw % SCALE_FACTOR;
    if (frac === 0n) {
      return `${isNegative ? "-" : ""}${whole.toString()}`;
    }
    const fracStr = frac.toString().padStart(SCALE_DECIMALS, "0").replace(/0+$/, "");
    return `${isNegative ? "-" : ""}${whole.toString()}.${fracStr}`;
  }

  public toJSON(): string {
    return this.toString();
  }
}
