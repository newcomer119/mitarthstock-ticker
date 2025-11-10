const erf = (x: number): number => {
  // Abramowitz and Stegun approximation
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        1.00002368 * t +
        0.37409196 * t * t +
        0.09678418 * t ** 3 -
        0.18628806 * t ** 4 +
        0.27886807 * t ** 5 -
        1.13520398 * t ** 6 +
        1.48851587 * t ** 7 -
        0.82215223 * t ** 8 +
        0.17087277 * t ** 9
    );
  return sign * (1 - tau);
};

export const normCdf = (x: number): number =>
  0.5 * (1 + erf(x / Math.sqrt(2)));

export const normPdf = (x: number): number =>
  (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);

