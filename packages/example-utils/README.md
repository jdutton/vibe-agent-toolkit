# @ts-monorepo-template/example-utils

> **⚠️ EXAMPLE PACKAGE - DELETE WHEN USING THIS TEMPLATE**
>
> This package exists only to validate the template setup. Delete it when creating your own project.

Example utility package demonstrating TypeScript monorepo patterns.

## Installation

```bash
npm install @ts-monorepo-template/example-utils
# or
bun add @ts-monorepo-template/example-utils
```

## Usage

```typescript
import { capitalize, isEmpty, truncate } from '@ts-monorepo-template/example-utils';

// Capitalize strings
capitalize('hello'); // 'Hello'

// Check if empty
isEmpty('   '); // true

// Truncate strings
truncate('hello world', 8); // 'hello...'
```

## API

### `capitalize(str: string): string`

Capitalizes the first letter of a string.

### `isEmpty(str: string): boolean`

Checks if a string is empty or only whitespace.

### `truncate(str: string, maxLength: number, suffix?: string): string`

Truncates a string to a maximum length with an optional suffix (default: '...').

## License

MIT
