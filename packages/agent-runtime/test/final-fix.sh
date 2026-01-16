#!/bin/bash

# Fix function-event-consumer.test.ts
sed -i '' '
s/async (input, ctx) => ({ processed: true })/async (_input, _ctx) => ({ processed: true })/g
10a\
const SUBSCRIBED_EVENTS = ['\''order.created'\'', '\''order.updated'\''];\

s/subscribesTo: \['\''order.created'\'', '\''order.updated'\''\]/subscribesTo: SUBSCRIBED_EVENTS/g
' function-event-consumer.test.ts

# Fix function-orchestrator.test.ts
sed -i '' '
s/async (input, ctx) => ({ processed: input.data })/async (input, _ctx) => ({ processed: input.data })/g
s/async (input, ctx) => ({ results: \[\] })/async (_input, _ctx) => ({ results: [] })/g
s/call: async (name, input)/call: async (_name, _input)/g
s/parallel: async (calls)/parallel: async (_calls)/g
s/input.items.map((item) => async () =>/input.items.map((item) => async () =>/g
' function-orchestrator.test.ts

# Fix llm-coordinator.test.ts
sed -i '' '
s/async (input, ctx) => ({ result: '\''done'\'' })/async (_input, _ctx) => ({ result: '\''done'\'' })/g
s/async (input, ctx) => ({ result: '\'' '\'' })/async (_input, _ctx) => ({ result: '\'''\'' })/g
' llm-coordinator.test.ts

# Fix llm-event-handler.test.ts
sed -i '' '
10a\
const SUBSCRIBED_EVENTS = ['\''ticket.created'\''];\

s/subscribesTo: \['\''ticket.created'\''\]/subscribesTo: SUBSCRIBED_EVENTS/g
s/async (input, ctx) => ({ priority: '\''high'\'', category: '\''technical'\'' })/async (_input, _ctx) => ({ priority: '\''high'\'', category: '\''technical'\'' })/g
s/callLLM: async (prompt)/callLLM: async (_prompt)/g
s/async (input, ctx) => ({ priority: '\'''\'', category: '\'''\''\'' })/async (_input, _ctx) => ({ priority: '\'''\'',' category: '\'''\'' })/g
' llm-event-handler.test.ts

echo "Final fixes applied"
