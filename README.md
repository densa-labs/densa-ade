# Densa ADE

Densa ADE is an agentic development environment where coding agents can plan, build, test, and iterate on software autonomously.

Densa ADE is developed by Densa Labs.

## Installation

TODO: fill in when initial development is finished

## Motive

You shouldn’t have to repeatedly tell an agent, “continue with the next milestone.”

You shouldn’t have to worry about your limits resetting while your agent sits idle.

Densa ADE is built to fix that.

AI coding agents are getting better at writing software every day, but using them still requires humans to orchestrate much of the development process. Densa ADE exists to automate that orchestration.

Densa ADE understands your project, writes a roadmap for your agent to follow, and can orchestrate it for you. Whether it runs fully autonomously or with human checkpoints is your choice.

Automation can make software development easier, but humans should remain in the loop. Human work and agent work should be able to coexist without the agent blindly overwriting your work.

By default, Densa ADE stops before continuing to the next phase. You can disable these checkpoints for fully autonomous execution at your own risk. Densa ADE does not commit, push, or delete your work unless explicitly approved.

## Disclaimer

Densa ADE is an experimental project currently under development. (TODO: delete “currently under development” when done)

AI agents can make mistakes, including modifying or deleting code.

We recommend using version control/backups and reviewing important changes.

Densa ADE has validation and recovery systems, but users **should not** rely on them as a guarantee of safety. These systems do not make autonomous execution perfectly safe.

Authenticated third-party coding agents are subject to their own terms, policies, and limits.

## License

Densa ADE written by Densa Labs is licensed under the **Apache License, Version 2.0**.
See [`LICENSE`](LICENSE).

Densa ADE is a thin downstream of Code-OSS (`microsoft/vscode`). Upstream Code-OSS code
remains under Microsoft's **MIT License**, and every modified Code-OSS file retains
Microsoft's MIT notice alongside the Densa ADE overlay. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`code-oss/`](code-oss/).

For technical documentation, see [`/docs`](docs/)
