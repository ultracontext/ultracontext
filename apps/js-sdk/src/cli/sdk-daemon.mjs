// SDK daemon entry-point — wires store + boots daemon without dotenv
import { createStore, resolveDbPath } from "@ultracontext/daemon/store";
import { daemonBoot } from "@ultracontext/daemon/daemon";

daemonBoot({ createStore, resolveDbPath });
