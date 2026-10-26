// random.Random(graine) de Python : le même générateur (Mersenne Twister, MT19937), semé de la même façon,
// et les mêmes tirages (randrange, choice, sample, shuffle). Avec la même graine, la version TypeScript tire
// les mêmes codes de confirmation (chapitre 17 : le banc d'essai) et le même échantillon de réponses à noter
// que la version Python.

const N = 624;
const M = 397;

export class HasardPython {
  private readonly mt = new Uint32Array(N);
  private index = N;

  /** random.seed(graine) pour un entier : la clé est |graine|, découpée en mots de 32 bits. */
  constructor(graine: number) {
    let reste = BigInt(Math.abs(graine));
    const cle: number[] = [];
    do {
      cle.push(Number(reste & 0xffffffffn));
      reste >>= 32n;
    } while (reste > 0n);
    this.initialiser(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, cle.length); k > 0; k--) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = ((this.mt[i]! ^ Math.imul(p, 1664525)) >>> 0) + cle[j]! + j;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= cle.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = ((this.mt[i]! ^ Math.imul(p, 1566083941)) >>> 0) - i;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  private initialiser(s: number): void {
    this.mt[0] = s;
    for (let i = 1; i < N; i++) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = Math.imul(1812433253, p) + i;
    }
    this.index = N;
  }

  private melanger(): void {
    for (let k = 0; k < N; k++) {
      const y = (this.mt[k]! & 0x80000000) | (this.mt[(k + 1) % N]! & 0x7fffffff);
      this.mt[k] = this.mt[(k + M) % N]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.index = 0;
  }

  /** Un mot de 32 bits (genrand_uint32). */
  private mot(): number {
    if (this.index >= N) this.melanger();
    let y = this.mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** getrandbits(k), pour k ≤ 32 : les k bits de poids fort d'un mot. */
  getrandbits(k: number): number {
    if (k < 0 || k > 32) throw new RangeError("getrandbits : de 0 à 32 bits ici");
    return k === 0 ? 0 : this.mot() >>> (32 - k);
  }

  /** _randbelow(n) : un entier de 0 à n − 1, tiré par rejet sur le nombre de bits de n. */
  randbelow(n: number): number {
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** randrange(n). */
  randrange(n: number): number {
    if (n <= 0) throw new RangeError("randrange : intervalle vide");
    return this.randbelow(n);
  }

  choice<T>(suite: readonly T[]): T {
    if (!suite.length) throw new RangeError("choice : suite vide");
    return suite[this.randbelow(suite.length)]!;
  }

  /** shuffle(x), sur place, depuis la fin. */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      [x[i], x[j]] = [x[j]!, x[i]!];
    }
  }

  /** sample(population, k), avec les deux méthodes de Python, choisies de la même façon. */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) throw new RangeError("sample : échantillon plus grand que la population");
    const resultat: T[] = new Array(k);
    let taille = 21;
    if (k > 5) taille += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= taille) {
      const reserve = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        resultat[i] = reserve[j]!;
        reserve[j] = reserve[n - i - 1]!;
      }
    } else {
      const choisis = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (choisis.has(j)) j = this.randbelow(n);
        choisis.add(j);
        resultat[i] = population[j]!;
      }
    }
    return resultat;
  }
}
