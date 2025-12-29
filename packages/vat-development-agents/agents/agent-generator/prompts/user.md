I want to create a new agent. Here's what I'm thinking:

{{userInput}}

{% if agentPurpose %}
**Purpose:** {{agentPurpose}}
{% endif %}

{% if successCriteria %}
**Success looks like:** {{successCriteria}}
{% endif %}

{% if typicalInputs %}
**Typical inputs:** {{typicalInputs}}
{% endif %}

{% if expectedOutputs %}
**Expected outputs:** {{expectedOutputs}}
{% endif %}

{% if domainContext %}
**Domain context:** {{domainContext}}
{% endif %}

{% if performanceRequirements %}
**Performance requirements:**
{% if performanceRequirements.latency %}
- Latency: {{performanceRequirements.latency}}
{% endif %}
{% if performanceRequirements.accuracy %}
- Accuracy: {{performanceRequirements.accuracy}}
{% endif %}
{% if performanceRequirements.cost %}
- Cost: {{performanceRequirements.cost}}
{% endif %}
{% endif %}

{% if additionalContext %}
**Additional context:** {{additionalContext}}
{% endif %}

Help me design this agent!
