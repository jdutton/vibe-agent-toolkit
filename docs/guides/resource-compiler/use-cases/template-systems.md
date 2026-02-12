---
title: Template System Patterns
description: Building dynamic content generation and template systems using compiled markdown resources
category: guide
tags: [resource-compiler, templates, i18n, email, content-generation]
audience: intermediate
---

# Template System Patterns

Build dynamic content generation systems using compiled markdown resources for templates, emails, and multi-language support.

---

## What This Guide Covers

- Dynamic email and notification generation
- Multi-language template systems (i18n)
- Variable substitution patterns
- Template composition
- Conditional content
- Testing templates

**Audience:** Developers building content generation, email systems, or internationalization solutions.

---

## Prerequisites

- Understanding of [resource compilation](../compiling-markdown-to-typescript.md)
- Basic TypeScript knowledge
- Familiarity with template concepts

---

## Email Templates

### Basic Email Template

```markdown
<!-- resources/templates/emails.md -->
---
title: Email Templates
category: templates
---

# Email Templates

## Welcome

Hi {{name}},

Welcome to {{productName}}! We're excited to have you on board.

To get started:
1. Verify your email: {{verifyLink}}
2. Complete your profile
3. Explore our features

Best regards,
The {{productName}} Team

## Password Reset

Hi {{name}},

We received a request to reset your password for {{productName}}.

Reset your password: {{resetLink}}

This link expires in {{expiryMinutes}} minutes.

If you didn't request this, please ignore this email.

Best regards,
The {{productName}} Team
```

### Template Rendering

```typescript
import * as EmailTemplates from '@acme/templates/generated/resources/templates/emails.js';

interface TemplateContext {
  [key: string]: string | number | boolean;
}

function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return String(context[key] ?? match);
  });
}

// Usage
const welcomeEmail = renderTemplate(
  EmailTemplates.fragments.welcome.body,
  {
    name: 'Alice',
    productName: 'VibeApp',
    verifyLink: 'https://app.vibe.com/verify/abc123',
  }
);

console.log(welcomeEmail);
```

### Email Service Integration

```typescript
import * as EmailTemplates from '@acme/templates/generated/resources/templates/emails.js';
import nodemailer from 'nodemailer';

interface EmailData {
  to: string;
  templateName: keyof typeof EmailTemplates.fragments;
  context: TemplateContext;
  subject?: string;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(data: EmailData) {
  const template = EmailTemplates.fragments[data.templateName];
  const body = renderTemplate(template.body, data.context);

  // Use template-specific subject or provided subject
  const subject =
    data.subject ||
    (EmailTemplates.meta[`${data.templateName}_subject`] as string) ||
    'Notification';

  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to: data.to,
    subject: renderTemplate(subject, data.context),
    text: body,
  });
}

// Usage
await sendEmail({
  to: 'user@example.com',
  templateName: 'welcome',
  context: {
    name: 'Alice',
    productName: 'VibeApp',
    verifyLink: 'https://app.vibe.com/verify/abc123',
  },
});
```

---

## Multi-Language Templates (i18n)

### Language-Specific Resources

```
resources/i18n/
├── en/
│   ├── messages.md
│   └── emails.md
├── fr/
│   ├── messages.md
│   └── emails.md
└── es/
    ├── messages.md
    └── emails.md
```

### English Templates

```markdown
<!-- resources/i18n/en/messages.md -->
---
title: English Messages
language: en
---

# Messages

## Welcome Message

Welcome to {{appName}}!

## Error Not Found

{{resource}} not found.

## Success Saved

Your {{item}} has been saved successfully.
```

### French Templates

```markdown
<!-- resources/i18n/fr/messages.md -->
---
title: Messages Français
language: fr
---

# Messages

## Welcome Message

Bienvenue à {{appName}}!

## Error Not Found

{{resource}} introuvable.

## Success Saved

Votre {{item}} a été enregistré avec succès.
```

### Translation Function

```typescript
import * as MessagesEN from '@acme/i18n/generated/resources/en/messages.js';
import * as MessagesFR from '@acme/i18n/generated/resources/fr/messages.js';
import * as MessagesES from '@acme/i18n/generated/resources/es/messages.js';

const translations = {
  en: MessagesEN,
  fr: MessagesFR,
  es: MessagesES,
};

type Locale = keyof typeof translations;
type MessageKey = keyof typeof MessagesEN.fragments;

function t(
  key: MessageKey,
  locale: Locale = 'en',
  variables?: Record<string, string>
): string {
  const messages = translations[locale];
  let text = messages.fragments[key]?.body || String(key);

  if (variables) {
    text = renderTemplate(text, variables);
  }

  return text;
}

// Usage
console.log(t('welcomeMessage', 'en'));                    // "Welcome to {{appName}}!"
console.log(t('welcomeMessage', 'fr'));                    // "Bienvenue à {{appName}}!"
console.log(t('errorNotFound', 'es', { resource: 'User' })); // "User no encontrado."
```

### React Integration

```typescript
import { createContext, useContext, useState } from 'react';

type TranslationContext = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<TranslationContext | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en');

  const translate = (key: MessageKey, vars?: Record<string, string>) =>
    t(key, locale, vars);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t: translate }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useTranslation must be used within I18nProvider');
  return context;
}

// Component usage
function WelcomeComponent() {
  const { t, locale, setLocale } = useTranslation();

  return (
    <div>
      <select value={locale} onChange={e => setLocale(e.target.value as Locale)}>
        <option value="en">English</option>
        <option value="fr">Français</option>
        <option value="es">Español</option>
      </select>

      <h1>{t('welcomeMessage', { appName: 'VibeApp' })}</h1>
    </div>
  );
}
```

---

## Notification Templates

### Slack/Discord Messages

```markdown
<!-- resources/templates/slack.md -->
---
title: Slack Notifications
---

# Slack Notifications

## Deployment Success

:rocket: *Deployment Successful*

*Environment:* {{environment}}
*Version:* {{version}}
*Deployed by:* {{deployer}}
*Duration:* {{duration}}

<{{dashboardUrl}}|View Dashboard>

## Incident Alert

:rotating_light: *INCIDENT ALERT*

*Severity:* {{severity}}
*Service:* {{service}}
*Description:* {{description}}

*Started:* {{startTime}}

<{{incidentUrl}}|View Incident> | <{{runbookUrl}}|Runbook>
```

### Slack API Integration

```typescript
import * as SlackTemplates from '@acme/templates/generated/resources/templates/slack.js';
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

interface SlackNotification {
  channel: string;
  templateName: keyof typeof SlackTemplates.fragments;
  context: TemplateContext;
}

async function sendSlackNotification(data: SlackNotification) {
  const template = SlackTemplates.fragments[data.templateName];
  const text = renderTemplate(template.body, data.context);

  await slack.chat.postMessage({
    channel: data.channel,
    text,
    mrkdwn: true,
  });
}

// Usage
await sendSlackNotification({
  channel: '#deployments',
  templateName: 'deploymentSuccess',
  context: {
    environment: 'production',
    version: 'v2.1.3',
    deployer: 'Alice',
    duration: '3m 42s',
    dashboardUrl: 'https://dashboard.acme.com',
  },
});
```

---

## Template Composition

### Composing Multiple Fragments

```typescript
import * as Header from '@acme/templates/generated/resources/parts/header.js';
import * as Footer from '@acme/templates/generated/resources/parts/footer.js';
import * as Content from '@acme/templates/generated/resources/content/welcome.js';

function composeEmail(
  contentFragment: string,
  context: TemplateContext
): string {
  const parts = [
    Header.fragments.emailHeader.body,
    contentFragment,
    Footer.fragments.emailFooter.body,
  ];

  const composed = parts.join('\n\n---\n\n');
  return renderTemplate(composed, context);
}

// Usage
const email = composeEmail(
  Content.fragments.welcomeContent.body,
  {
    name: 'Alice',
    productName: 'VibeApp',
  }
);
```

### Layout System

```typescript
interface LayoutData {
  header?: string;
  footer?: string;
  sidebar?: string;
  content: string;
}

function applyLayout(data: LayoutData, context: TemplateContext): string {
  const parts: string[] = [];

  if (data.header) parts.push(data.header);
  if (data.sidebar) parts.push('## Sidebar\n' + data.sidebar);
  parts.push('## Content\n' + data.content);
  if (data.footer) parts.push(data.footer);

  const composed = parts.join('\n\n');
  return renderTemplate(composed, context);
}
```

---

## Conditional Content

### Simple Conditionals

```markdown
## Product Update

Hi {{name}},

{{#isPremium}}
As a premium member, you get early access to new features!
{{/isPremium}}

{{^isPremium}}
Upgrade to premium for early access to new features.
{{/isPremium}}

Check out what's new...
```

### Implementation

```typescript
interface ConditionalContext extends TemplateContext {
  [key: string]: any;
}

function renderConditionalTemplate(
  template: string,
  context: ConditionalContext
): string {
  // Handle positive conditionals {{#key}}...{{/key}}
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (match, key, content) => {
      return context[key] ? content : '';
    }
  );

  // Handle negative conditionals {{^key}}...{{/key}}
  result = result.replace(
    /\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (match, key, content) => {
      return !context[key] ? content : '';
    }
  );

  // Handle variable substitution
  result = renderTemplate(result, context);

  return result;
}

// Usage
const email = renderConditionalTemplate(template, {
  name: 'Alice',
  isPremium: true,
});
```

---

## Advanced Patterns

### Template Inheritance

```typescript
import * as Base from '@acme/templates/generated/resources/base.js';
import * as Specific from '@acme/templates/generated/resources/specific.js';

function inheritTemplate(
  baseFragmentName: keyof typeof Base.fragments,
  overrideFragmentName: keyof typeof Specific.fragments,
  context: TemplateContext
): string {
  const base = Base.fragments[baseFragmentName].body;
  const override = Specific.fragments[overrideFragmentName].body;

  // Merge: override takes precedence for {{blocks}}
  const merged = base.replace(/\{\{block:(\w+)\}\}/g, (match, blockName) => {
    const blockRegex = new RegExp(`{{block:${blockName}}}([\\s\\S]*?){{/block:${blockName}}}`);
    const blockMatch = override.match(blockRegex);
    return blockMatch ? blockMatch[1] : match;
  });

  return renderTemplate(merged, context);
}
```

### Parameterized Blocks

```markdown
## Email Template

{{block:header}}
Default header content
{{/block:header}}

{{block:body}}
Default body content
{{/block:body}}

{{block:footer}}
Default footer content
{{/block:footer}}
```

### Template Caching

```typescript
const templateCache = new Map<string, string>();

function getCachedTemplate(
  fragmentGetter: () => string,
  cacheKey: string
): string {
  if (!templateCache.has(cacheKey)) {
    templateCache.set(cacheKey, fragmentGetter());
  }
  return templateCache.get(cacheKey)!;
}

// Usage
const template = getCachedTemplate(
  () => EmailTemplates.fragments.welcome.body,
  'email:welcome'
);
```

---

## Testing Templates

### Unit Testing

```typescript
import { describe, it, expect } from 'vitest';
import * as Templates from '@acme/templates/generated/resources/templates/emails.js';

describe('Email Templates', () => {
  it('should have all required templates', () => {
    expect(Templates.fragments).toHaveProperty('welcome');
    expect(Templates.fragments).toHaveProperty('passwordReset');
  });

  it('should render variables correctly', () => {
    const result = renderTemplate(Templates.fragments.welcome.body, {
      name: 'Alice',
      productName: 'TestApp',
      verifyLink: 'https://test.com/verify',
    });

    expect(result).toContain('Alice');
    expect(result).toContain('TestApp');
    expect(result).toContain('https://test.com/verify');
    expect(result).not.toContain('{{');
  });

  it('should handle missing variables gracefully', () => {
    const result = renderTemplate(Templates.fragments.welcome.body, {
      name: 'Bob',
      // Missing: productName, verifyLink
    });

    expect(result).toContain('Bob');
    expect(result).toContain('{{productName}}');  // Preserved
  });
});
```

### Snapshot Testing

```typescript
it('matches snapshot for welcome email', () => {
  const result = renderTemplate(Templates.fragments.welcome.body, {
    name: 'Alice',
    productName: 'VibeApp',
    verifyLink: 'https://app.vibe.com/verify/test123',
  });

  expect(result).toMatchSnapshot();
});
```

### Integration Testing

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Email Service', () => {
  it('should send welcome email', async () => {
    const mockTransport = {
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-123' }),
    };

    await sendEmail({
      to: 'test@example.com',
      templateName: 'welcome',
      context: {
        name: 'Test User',
        productName: 'TestApp',
        verifyLink: 'https://test.com/verify',
      },
    });

    expect(mockTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        subject: expect.stringContaining('Welcome'),
        text: expect.stringContaining('Test User'),
      })
    );
  });
});
```

---

## Best Practices

### 1. Separate Content from Logic

```typescript
// ✅ Good: Templates in markdown, logic in code
const template = EmailTemplates.fragments.welcome.body;
const email = renderTemplate(template, getUserContext(user));

// ❌ Avoid: Mixing content and logic
const email = `Hi ${user.name}, welcome to ${app.name}!`;
```

### 2. Provide Template Metadata

```markdown
---
title: Welcome Email
category: transactional
priority: high
estimatedLength: 300
requiredVariables: [name, productName, verifyLink]
optionalVariables: [referrer]
---
```

### 3. Version Templates

```
resources/templates/
├── v1/
│   └── emails.md
└── v2/
    └── emails.md
```

### 4. Validate Required Variables

```typescript
function validateTemplateContext(
  templateName: string,
  context: TemplateContext,
  requiredVars: string[]
): void {
  const missing = requiredVars.filter(v => !(v in context));

  if (missing.length > 0) {
    throw new Error(
      `Template '${templateName}' missing required variables: ${missing.join(', ')}`
    );
  }
}

// Usage
validateTemplateContext('welcome', context, ['name', 'productName', 'verifyLink']);
const email = renderTemplate(template, context);
```

### 5. Escape User Input

```typescript
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return text.replace(/[&<>"']/g, m => map[m]);
}

function renderSafeTemplate(template: string, context: TemplateContext): string {
  const safeContext = Object.fromEntries(
    Object.entries(context).map(([k, v]) => [k, escapeHtml(String(v))])
  );

  return renderTemplate(template, safeContext);
}
```

### 6. Track Template Usage

```typescript
const templateMetrics = new Map<string, { count: number; lastUsed: Date }>();

function trackTemplateUsage(templateName: string) {
  const current = templateMetrics.get(templateName) || { count: 0, lastUsed: new Date() };
  current.count++;
  current.lastUsed = new Date();
  templateMetrics.set(templateName, current);
}

// Usage
trackTemplateUsage('welcome');
const email = renderTemplate(EmailTemplates.fragments.welcome.body, context);
```

---

## Next Steps

- [Building Agent Prompt Libraries](./agent-prompt-libraries.md) - For AI agent prompts
- [Creating RAG Knowledge Bases](./rag-knowledge-bases.md) - For documentation search
- [Advanced Patterns](./advanced-patterns.md) - Multi-collection packages and schemas

---

## See Also

- [Overview: Compiling Markdown to TypeScript](../compiling-markdown-to-typescript.md)
- [Publishing Packages](../publishing-packages.md)
- [Consuming Packages](../consuming-packages.md)
- [Guide Index](../README.md)
