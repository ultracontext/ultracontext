// SDK sync entry-point — wires store + boots daemon without dotenv
import { createStore, resolveDbPath } from "@ultracontext/sync/store";
import { daemonBoot } from "@ultracontext/sync/sync";

daemonBoot({ createStore, resolveDbPath });
