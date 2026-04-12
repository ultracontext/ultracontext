// entry point — load env, create store, boot daemon
import "./env.mjs";
import { createStore, resolveDbPath } from "./store.mjs";
import { daemonBoot } from "./daemon.mjs";

daemonBoot({ createStore, resolveDbPath });
