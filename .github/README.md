<div align="center">

# ticker

**See what a long command is doing, in plain words.**

[![Release](https://img.shields.io/github/v/release/adamalshoomary/ticker?label=release&color=1d5fb8)](https://github.com/adamalshoomary/ticker/releases/latest)
[![Licence](https://img.shields.io/badge/licence-MIT-718096)](/ticker/LICENSE)

<a href="https://adamalshoomary.github.io/ticker/"><img src="/ticker/site/install-button.svg" alt="Install ticker" height="44"></a>

</div>

![Two desktop app chats run the same command: download the requests library, install its packages and run its 618 tests. The right chat has ticker, and the line under the command says how the tests are going and that one timeout test failed. The left chat shows only "Cloning requests, install dev deps, run tests". Both end with Claude's summary.](/ticker/docs/demo.gif)

<p align="center"><sub><a href="/ticker/docs/demo.mp4">Full run, slower</a></sub></p>

## Install

Paste this into Claude Code:

```
Install the ticker mod from https://github.com/adamalshoomary/ticker.
```

<details>
<summary>Another way to install</summary>

In the desktop app: click **+** next to the prompt box, then **Plugins**, then **Add marketplace**. Type `adamalshoomary/ticker`, then click **Add plugin**.

</details>

## What you see

![A running command's row, "Running the requests tests, 36s". Under it, ticker's wave and line: "Running the requests tests; 25 passed so far, none failed".](/ticker/docs/line.png)

A command that runs for 30 seconds gets a line under it. The line says how far the command is and what failed. It goes when the command ends. Commands in the background get the line too.

## Two ways to write the line

| Haiku (the default) | Free mode |
|---|---|
| *Building module 15 of 30, no errors so far* | *Step 15 of 30* |
| Haiku, Claude's smallest model, writes a sentence. | ticker writes the line from its own counts. |
| Uses a tiny bit of your plan. | Costs nothing. |

Type `/ticker` in the chat to switch between them.

<details>
<summary>Cost and privacy</summary>

- Haiku is asked at 30 seconds, then every 20 seconds while the command prints. It is asked every 60 seconds while the command is quiet, and 30 times per command at most.
- Each call uses your own login. With an API key, a call costs about $0.0001.
- Each call sends the command, its description and the newest 25 lines. Keys, tokens and passwords are hidden first.
- If a command prints secrets, use free mode.

</details>

<details>
<summary>Updates</summary>

Once a day, ticker checks GitHub for a new version. When one is out, a line above the prompt shows **Update** and **Later**. Nothing installs until you click **Update**.

</details>

<details>
<summary>Limits</summary>

- A command that ends within 30 seconds gets no line.
- A command that pipes into `tail`, `grep` or `sort` shows little until it ends. The line says so.
- When Claude folds several commands into one box, the line shows only while the box is open.
- ticker reads a file that Claude Code does not document. An update to Claude Code can blank the line. Commands still run.
- Tested in the desktop app on macOS, Claude Code 2.1.309. Linux and Windows are untested.

</details>

<details>
<summary>How it works</summary>

1. Every 5 seconds, ticker reads the new output of each running command.
2. Its rules count tests, files and steps for Python, pytest, Go, cargo, jest, C compilers, make, ninja, cmake, Gradle, npm and pip. For other tools, the line is the last printed line.
3. At 30 seconds, the rules line shows. Haiku then writes a sentence from the counts.
4. ticker checks each number in the sentence against its counts. If a number does not match, the rules line stays.

To check the mod, run `claude plugin validate ticker` and `claude plugin test ticker` in this repository.

</details>

<details>
<summary>For agents</summary>

If a user asks you to install ticker from this page:

1. Run `claude plugin install ticker --marketplace adamalshoomary/ticker`.
2. Tell the user to start a new session.
3. Tell the user that the line shows after a command runs for 30 seconds.

</details>

MIT licence. See [LICENSE](/ticker/LICENSE).
