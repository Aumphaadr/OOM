/**
 * Точное рациональное число (bigint числитель/знаменатель).
 * Модель никогда не хранит float: форматирование — только при отображении
 * (урок старого прототипа: cleanNumber() мутировал значение — сюда такое не пускаем).
 */
export class Rational {
  readonly num: bigint;
  readonly den: bigint; // всегда > 0

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = typeof num === 'number' ? BigInt(Math.trunc(num)) : num;
    let d = typeof den === 'number' ? BigInt(Math.trunc(den)) : den;
    if (d === 0n) throw new Error('Знаменатель не может быть нулём');
    if (d < 0n) { n = -n; d = -d; }
    const g = Rational.gcd(n < 0n ? -n : n, d);
    return new Rational(g === 0n ? 0n : n / g, g === 0n ? 1n : d / g);
  }

  /** Разбор пользовательского ввода: "5", "-2.75", "1/3". */
  static parse(text: string): Rational | null {
    const s = text.trim().replace(',', '.');
    if (/^-?\d+$/.test(s)) return Rational.of(BigInt(s));
    const frac = s.match(/^(-?\d+)\s*\/\s*(\d+)$/);
    if (frac) {
      const den = BigInt(frac[2]!);
      if (den === 0n) return null;
      return Rational.of(BigInt(frac[1]!), den);
    }
    const dec = s.match(/^(-?)(\d+)\.(\d+)$/);
    if (dec) {
      const sign = dec[1] === '-' ? -1n : 1n;
      const whole = BigInt(dec[2]!);
      const fracDigits = dec[3]!;
      const den = 10n ** BigInt(fracDigits.length);
      return Rational.of(sign * (whole * den + BigInt(fracDigits)), den);
    }
    return null;
  }

  private static gcd(a: bigint, b: bigint): bigint {
    while (b) { [a, b] = [b, a % b]; }
    return a;
  }

  add(o: Rational): Rational { return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o: Rational): Rational { return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o: Rational): Rational { return Rational.of(this.num * o.num, this.den * o.den); }
  div(o: Rational): Rational {
    if (o.num === 0n) throw new Error('Деление на ноль');
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational { return Rational.of(-this.num, this.den); }

  isZero(): boolean { return this.num === 0n; }
  isInteger(): boolean { return this.den === 1n; }
  sign(): -1 | 0 | 1 { return this.num === 0n ? 0 : this.num < 0n ? -1 : 1; }

  equals(o: Rational): boolean { return this.num === o.num && this.den === o.den; }
  compare(o: Rational): -1 | 0 | 1 {
    const d = this.num * o.den - o.num * this.den;
    return d === 0n ? 0 : d < 0n ? -1 : 1;
  }

  /** Приближение для позиционирования на экране (не для хранения!). */
  toNumber(): number { return Number(this.num) / Number(this.den); }

  /**
   * Отображение: целые — как есть; конечные десятичные (знаменатель 2^a·5^b) —
   * десятичной записью; прочие — обыкновенной дробью.
   */
  toDisplay(): string {
    if (this.den === 1n) return this.num.toString();
    let d = this.den;
    let twos = 0, fives = 0;
    while (d % 2n === 0n) { d /= 2n; twos++; }
    while (d % 5n === 0n) { d /= 5n; fives++; }
    if (d === 1n) {
      const digits = Math.max(twos, fives);
      const scale = 10n ** BigInt(digits);
      const scaled = (this.num < 0n ? -this.num : this.num) * scale / this.den;
      const s = scaled.toString().padStart(digits + 1, '0');
      const whole = s.slice(0, s.length - digits);
      const frac = s.slice(s.length - digits).replace(/0+$/, '');
      const sign = this.num < 0n ? '-' : '';
      return frac.length ? `${sign}${whole},${frac}` : `${sign}${whole}`;
    }
    return `${this.num}/${this.den}`;
  }
}

/** Целочисленный корень (floor) для bigint ≥ 0, метод Ньютона. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt из отрицательного');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Целочисленный кубический корень (floor) для bigint ≥ 0, бинарный поиск. */
function icbrt(n: bigint): bigint {
  if (n < 0n) throw new Error('icbrt из отрицательного');
  if (n < 2n) return n;
  let lo = 1n;
  let hi = 1n << BigInt(Math.ceil(n.toString(2).length / 3) + 1);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid * mid * mid <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Точный квадратный корень: Rational, если он рационален, иначе null. */
export function sqrtExact(v: Rational): Rational | null {
  if (v.num < 0n) return null;
  const sn = isqrt(v.num);
  const sd = isqrt(v.den);
  if (sn * sn === v.num && sd * sd === v.den) return Rational.of(sn, sd);
  return null;
}

/** Точный кубический корень: Rational, если он рационален, иначе null. */
export function cbrtExact(v: Rational): Rational | null {
  const neg = v.num < 0n;
  const an = neg ? -v.num : v.num;
  const cn = icbrt(an);
  const cd = icbrt(v.den);
  if (cn * cn * cn === an && cd * cd * cd === v.den) {
    return Rational.of(neg ? -cn : cn, cd);
  }
  return null;
}

/** Приближённый √ до `digits` знаков после запятой (v ≥ 0), округление к ближайшему. */
export function sqrtApprox(v: Rational, digits = 3): Rational {
  const scale = 10n ** BigInt(digits);
  const target = (v.num * scale * scale) / v.den; // √(num/den)·10^d = √(num·10^2d/den)
  let s = isqrt(target);
  if ((s + 1n) * (s + 1n) - target < target - s * s) s += 1n;
  return Rational.of(s, scale);
}

/** Приближённый ∛ до `digits` знаков после запятой, округление к ближайшему. */
export function cbrtApprox(v: Rational, digits = 3): Rational {
  const neg = v.num < 0n;
  const scale = 10n ** BigInt(digits);
  const target = ((neg ? -v.num : v.num) * scale * scale * scale) / v.den;
  let s = icbrt(target);
  const cube = (x: bigint) => x * x * x;
  if (cube(s + 1n) - target < target - cube(s)) s += 1n;
  return Rational.of(neg ? -s : s, scale);
}

/** Целочисленный корень k-й степени (floor) для bigint ≥ 0, бинарный поиск. */
function irootK(n: bigint, k: bigint): bigint {
  if (n < 0n) throw new Error('irootK из отрицательного');
  if (n < 2n) return n;
  let lo = 1n;
  let hi = 1n << BigInt(Math.ceil(n.toString(2).length / Number(k)) + 1);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid ** k <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Целая степень v^e; отрицательная e переворачивает дробь (v ≠ 0). */
export function powInt(v: Rational, e: bigint): Rational {
  if (e === 0n) return Rational.of(1n);
  const k = e < 0n ? -e : e;
  const num = v.num ** k;
  const den = v.den ** k;
  if (e < 0n) {
    if (num === 0n) throw new Error('Деление на ноль');
    return Rational.of(den, num); // of() нормализует знак
  }
  return Rational.of(num, den);
}

/** Точный корень k-й степени (k ≥ 2): Rational, если рационален, иначе null.
 *  Отрицательные допустимы только при нечётном k. */
export function rootExact(v: Rational, k: bigint): Rational | null {
  const neg = v.num < 0n;
  if (neg && k % 2n === 0n) return null;
  const an = neg ? -v.num : v.num;
  const rn = irootK(an, k);
  const rd = irootK(v.den, k);
  if (rn ** k === an && rd ** k === v.den) return Rational.of(neg ? -rn : rn, rd);
  return null;
}

/** Приближённый корень k-й степени до `digits` знаков, округление к ближайшему. */
export function rootApprox(v: Rational, k: bigint, digits = 3): Rational {
  const neg = v.num < 0n;
  const scale = 10n ** BigInt(digits);
  const target = ((neg ? -v.num : v.num) * scale ** k) / v.den;
  let s = irootK(target, k);
  if ((s + 1n) ** k - target < target - s ** k) s += 1n;
  return Rational.of(neg ? -s : s, scale);
}

export const R = Rational.of;
