/**
 * Shared utilities for extracting cat color information from text.
 * Used by both description parser and photo analyzer.
 */

/**
 * Extracts fur color from text based on keyword matching.
 * Returns a standardized color name.
 *
 * @param text - Text to search for color keywords (case-insensitive)
 * @param defaultColor - Default color if no keywords found (default: varies by caller)
 * @returns Standardized fur color name
 */
export function extractFurColor(text: string, defaultColor?: string): string {
  const lowerText = text.toLowerCase();

  if (lowerText.includes('orange') || lowerText.includes('ginger')) {
    return 'Orange';
  }
  if (lowerText.includes('black')) {
    return 'Black';
  }
  if (lowerText.includes('white')) {
    return 'White';
  }
  if (lowerText.includes('gray') || lowerText.includes('grey')) {
    return 'Gray';
  }
  if (lowerText.includes('brown')) {
    return 'Brown';
  }
  if (lowerText.includes('cream')) {
    return 'Cream';
  }
  if (lowerText.includes('calico')) {
    return 'Calico (white, orange, black)';
  }
  if (lowerText.includes('tortoiseshell') || lowerText.includes('tortie')) {
    return 'Tortoiseshell';
  }
  if (lowerText.includes('silver')) {
    return 'Silver';
  }

  // Return provided default or a generic default
  return defaultColor ?? 'Mixed colors';
}
