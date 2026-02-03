/**
 * Round a number to specified significant figures.
 *
 * @param value - Number to round
 * @param sigFigs - Number of significant figures
 * @returns Rounded number
 *
 * @example
 * roundToSigFigs(0.351234, 3) // 0.351
 * roundToSigFigs(1234.567, 3) // 1230
 */
export function roundToSigFigs(value: number, sigFigs: number): number {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value))) + 1;
  const scale = Math.pow(10, sigFigs - magnitude);
  return Math.round(value * scale) / scale;
}

/**
 * Format duration from milliseconds to seconds with 3 significant figures.
 *
 * @param durationMs - Duration in milliseconds
 * @returns Duration in seconds, rounded to 3 significant figures
 *
 * @example
 * formatDurationSecs(351) // 0.351
 * formatDurationSecs(15) // 0.015
 */
export function formatDurationSecs(durationMs: number): number {
  return roundToSigFigs(durationMs / 1000, 3);
}
