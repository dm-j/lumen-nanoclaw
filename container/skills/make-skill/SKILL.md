---
name: make-skill
description: Write a well-specified pseudocode skill that communicates a task to another agent.
---

# Make Skill

```text
skill: write_skill

goal:
    produce a skill that communicates a task clearly to another agent

the resulting skill should:
    describe the desired outcome rather than prescribing a procedure
    contain enough context for the receiving agent to understand the task
    make success distinguishable from partial or incorrect completion
    state important constraints explicitly
    distinguish requirements from preferences
    identify relevant resources or capabilities without requiring their use
    give the receiving agent discretion over implementation
    bound that discretion where resource use, authority, risk, or cost should not depend solely on the receiving agent's judgment

include when relevant:
    goal:
        the state, answer, artifact, or effect that should exist when complete

    deliverable:
        what should be returned or produced

    requirements:
        properties the result must have to be considered successful

    constraints:
        things the receiving agent must not do
        boundaries on authority, scope, mutation, disclosure, or risk
        a later instruction does not implicitly override an established constraint

    budget:
        hard limits within which the receiving agent may choose its own approach
        examples include:
            maximum documents or records inspected
            maximum searches or external requests
            maximum tokens or model calls
            maximum elapsed time
            maximum monetary cost
            maximum number or depth of delegated tasks

        use budgets to bound discretion, not to prescribe procedure
        a budget is a maximum, not a target — permit the receiving agent to finish
            below it once further work is unlikely to materially improve the result
        avoid arbitrary limits when resource use is immaterial

    escalation:
        what the receiving agent should do when requirements cannot be satisfied within the available authority, budget, or information

        prefer returning:
            what was accomplished
            what remains unresolved
            why completion was not possible
            what additional authority, information, or budget would permit completion

        do not silently exceed a stated boundary merely to complete the task

    state:
        what persists between invocations of the receiving agent, and why
        read:
            what to read at the start of a run, and how to use it
        write:
            what must be written at the end of a run
            unconditional — required regardless of whether the run succeeded
            format and size bounds

        use state for standing/recurring agents with memory across runs, not one-shot tasks
        distinct from context (facts supplied for this run) and resources (things that
            may optionally be consulted) — state is what the agent itself must maintain

    context:
        facts or assumptions necessary to interpret the task correctly

    resources:
        capabilities, documents, tools, agents, or information sources that may be useful

    preferences:
        desirable properties that may be traded off when necessary

    uncertainty:
        ambiguities the receiving agent should resolve through judgment
        questions that should be surfaced rather than silently assumed

when describing resources:
    refer to capabilities semantically
    do not prescribe a concrete implementation unless required

when describing process:
    omit steps that merely explain how you would solve the task
    include a procedural requirement only when the procedure contributes to the desired outcome

examples of meaningful procedural requirements:
    verify the claim independently
    preserve the original data
    obtain approval before destructive changes
    cite evidence used for conclusions

examples of implementation details to omit:
    search before reading
    call one particular tool first
    inspect exactly five documents merely because five seems sufficient
    use a particular model
    traverse links to a predetermined depth

when prudence matters:
    do not replace a desired resource boundary with a detailed procedure
    express the boundary as a budget instead

    prefer:
        gather sufficient evidence to support the conclusion
        budget:
            document_reads: 12

    over:
        search for five documents
        read each result
        follow links to depth two

    allow prudent receivers to stop early
    ensure imprudent receivers still encounter a hard boundary

before returning the skill:
    ensure that another competent agent could choose a different method and still satisfy it
    remove instructions that constrain method without constraining outcome, authority, or necessary epistemic properties
    make implicit acceptance criteria explicit where useful
    add explicit budgets where relying on the receiving agent's prudence would create material cost, risk, or runaway behavior
    provide an escalation path when a hard boundary may prevent successful completion
    specify state when the receiving agent persists memory across invocations
    preserve genuine ambiguity rather than inventing precision

return:
    the completed skill in pseudocode
```
