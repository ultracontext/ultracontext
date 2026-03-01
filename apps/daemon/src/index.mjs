// thin entry-point — loads env, wires store, boots daemon
import "./env.mjs";
import { createStore, resolveDbPath } from "./store.mjs";
import { daemonBoot } from "./daemon.mjs";

daemonBoot({ createStore, resolveDbPath });
