#!/bin/bash

# Fix external-event-integrator.test.ts
sed -i '' '
s/async (input, ctx) => ({ approved: true })/async (_input, _ctx) => ({ approved: true })/g
s/waitFor: async <T>(eventType: string, timeoutMs: number): Promise<T> =>/waitFor: async <T>(_eventType: string, _timeoutMs: number): Promise<T> =>/g
' external-event-integrator.test.ts

# Add constants to external-event-integrator.test.ts
sed -i '' '
/^import { defineExternalEventIntegrator }/a\
\
const AGENT_NAME = '\''approval-agent'\'';\
const AGENT_DESC = '\''Requests human approval'\'';\
const AGENT_VERSION = '\''1.0.0'\'';
s/'\''approval-agent'\''/AGENT_NAME/g
s/'\''Requests human approval'\''/AGENT_DESC/g
s/'\''1.0.0'\''/AGENT_VERSION/g
' external-event-integrator.test.ts

# Fix function-event-consumer.test.ts - add constants
sed -i '' '
/^import { defineFunctionEventConsumer }/a\
\
const AGENT_NAME = '\''event-consumer'\'';\
const AGENT_DESC = '\''Consumes events'\'';\
const AGENT_VERSION = '\''1.0.0'\'';
s/'\''event-consumer'\''/AGENT_NAME/g
s/'\''Consumes events'\''/AGENT_DESC/g
s/'\''1.0.0'\''/AGENT_VERSION/g
' function-event-consumer.test.ts

# Fix llm-coordinator.test.ts
sed -i '' '
/^import { defineLLMCoordinator }/a\
\
const AGENT_NAME = '\''coordinator'\'';\
const AGENT_DESC = '\''Coordinates tasks'\'';\
const AGENT_VERSION = '\''1.0.0'\'';
s/'\''coordinator'\''/AGENT_NAME/g
s/'\''Coordinates tasks'\''/AGENT_DESC/g
s/'\''1.0.0'\''/AGENT_VERSION/g
' llm-coordinator.test.ts

# Fix llm-event-handler.test.ts
sed -i '' '
/^import { defineLLMEventHandler }/a\
\
const AGENT_NAME = '\''event-handler'\'';\
const AGENT_DESC = '\''Handles events with LLM'\'';\
const AGENT_VERSION = '\''1.0.0'\'';
s/'\''event-handler'\''/AGENT_NAME/g
s/'\''Handles events with LLM'\''/AGENT_DESC/g
s/'\''1.0.0'\''/AGENT_VERSION/g
' llm-event-handler.test.ts

# Fix function-orchestrator.test.ts
sed -i '' '
/^import { defineFunctionOrchestrator }/a\
\
const AGENT_NAME = '\''orchestrator'\'';\
const AGENT_DESC = '\''Orchestrates workflow'\'';\
const AGENT_VERSION = '\''1.0.0'\'';
s/'\''orchestrator'\''/AGENT_NAME/g
s/'\''Orchestrates workflow'\''/AGENT_DESC/g
s/'\''1.0.0'\''/AGENT_VERSION/g
' function-orchestrator.test.ts

echo "Test files fixed"
