# Vision Statement Shellmate

Build an LLM-enabled remote connection manager that combines the control of a traditional SSH and remote desktop client with the assistance of an agentic AI operator.

The application should help users connect to, understand, operate, and maintain remote machines through a primary interface that pairs a live terminal or remote session with an adjacent agent chat. The user remains responsible for configuring connections, credentials, permissions, and available tools. The agent operates only within the access the user explicitly provides.

The goal is to create something in the spirit of mRemoteNG for the AI era: a centralized place to manage remote systems, launch sessions, organize connection context, and ask an AI agent to perform useful work on targeted machines.

The core experience should make it easy for a user to say things like “check why this service is failing,” “update this config,” “compare these two servers,” “write down what you changed,” or “remind me what this machine is used for,” while still preserving visibility, control, and accountability.

The product should support OpenAI as a first-class LLM provider, especially for users with an OpenAI subscription, while also allowing arbitrary OpenAI-compatible API endpoints. Users should be able to choose the model/provider that fits their privacy, cost, latency, and capability needs.

Each connection should have persistent, user-visible notes that both the user and agent can read and write. These notes should help the agent remember prior work, machine purpose, configuration details, gotchas, troubleshooting history, and user preferences. Notes should never be hidden agent memory; they should be visible, editable, and manageable by the user.

The application should prioritize transparency, safety, and user control. The agent should assist the user in operating remote systems, not obscure what is happening. It should make actions understandable, request confirmation for risky operations, keep useful records of its work, and avoid surprising the user.

## What the application should do

The application should:

* Manage SSH connections and eventually remote desktop-style connections in one organized interface.
* Provide a main workspace with the remote terminal or desktop view alongside an agent chat.
* Let users target one or more configured connections and ask an LLM agent to perform actions on those systems.
* Treat OpenAI as a first-class provider while supporting any OpenAI API-compatible LLM endpoint.
* Allow users to configure what access, tools, credentials, and remote capabilities are available to the agent.
* Give the agent access to user-visible notes for each connection.
* Let the agent create, update, and reference notes about previous actions, system purpose, configurations, and troubleshooting history.
* Keep the user in control of connection setup, credentials, permissions, and model choice.
* Make agent actions observable, reviewable, and interruptible.
* Distinguish clearly between what the user did, what the agent suggested, and what the agent executed.
* Help users operate remote systems faster without requiring them to surrender judgment or control.

## What the application should not do

The application should not:

* Hide agent behavior from the user.
* Treat the agent as an unrestricted administrator by default.
* Automatically infer or expand access beyond what the user configured.
* Store secret information in notes unless the user explicitly chooses to do so.
* Create opaque private memory that the user cannot view, edit, or delete.
* Lock users into one model provider.
* Require OpenAI specifically when another OpenAI-compatible endpoint is preferred.
* Execute high-risk actions without appropriate confirmation or safeguards.
* Pretend the LLM understands a machine’s history unless that history exists in visible notes, logs, or current session context.
* Replace the user’s responsibility for permissions, security boundaries, and operational judgment.
