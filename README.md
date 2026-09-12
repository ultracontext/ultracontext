<div align="center">
  <h1>UltraContext</h1>
  <h3>Context that goes beyond.</h3>
  <p>Agents, sessions, machines, teams. Anything.</p>
</div>

---

I built UltraContext because I wanted a universal context for myself. Context that goes beyond the agent I use. One place to search all my activity, across everything I use. An agentic Dropbox.

I wanted to start my day with work, not with a search problem.

I needed four things:

- agentic search on top of it
- runs anywhere
- hackable and extensible, so I could write drivers that keep it updated
- an excuse to build with Rust

So I built it.

UltraContext is an open-source context toolkit for AI agents. A small Rust kernel runs everywhere, and it is fast. Everything else is a driver. The result is one interface to work with context of any shape, in any place.

What I use it for:

- a personal agentic Dropbox
- a company brain for Impossibl
- continuous data ingestors. An iOS relay talks to a Shortcut on my iPhone over SSH, pulls my ChatGPT sessions live, and syncs them into my agentic Dropbox
- custom harnesses, with an SDK that works like git for context
- agent-friendly access to any system
- edge agents

It is still a mess. There are several branches and unfinished thoughts, but the essence is there. I am committed to polish it into the best context toolkit out there.

If we want collective intelligence, we must organize it. Everyone is welcome to contribute.
