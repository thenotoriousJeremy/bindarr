# Contributing to Bindarr

Bug reports, ideas, translations and pull requests are all welcome.

- **A bug or an idea:** [open an issue](https://github.com/thenotoriousJeremy/bindarr/issues/new/choose).
  Say which version you run and how (Docker, the server binary, the phone app with
  a server or on its own).
- **A security problem:** report it privately, as [SECURITY.md](SECURITY.md)
  describes, not in an issue.
- **A translation:** [docs/TRANSLATING.md](docs/TRANSLATING.md). No programming
  needed.
- **Code:** read [AGENTS.md](AGENTS.md) first. It is short, and it is the project's
  rulebook: the architecture, the conventions, and what every change has to pass.
  [PROJECT.md](PROJECT.md) is the longer reference.

## Before you open a pull request

```sh
npm run install:all
npm test                       # every suite: backend unit and e2e, frontend, locales, mirror
cd frontend && npm run lint    # warnings fail CI
```

The pull request template has the checklist CI and review will hold the change
to. In short: tests for new behaviour, user-facing text through the translation
files, a new API route mounted for the phone app's device mode too (or answering
501 there), and tests that stay offline. Nothing may contact tcgcsv.com: prices
come from the project's mirror.

One change per pull request is easiest to review. For anything large, opening an
issue first to agree on the approach saves rework.

Contributions are released under the project's [MIT License](LICENSE).
