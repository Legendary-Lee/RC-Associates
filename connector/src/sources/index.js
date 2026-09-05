import * as bidnet from "./bidnet.js";
import * as euna from "./euna.js";

const REGISTRY = new Map([bidnet, euna].map((m) => [m.type, m]));

export function getSource(type) {
  const module = REGISTRY.get(type);
  if (!module) {
    throw new Error(`unknown source type "${type}" (available: ${[...REGISTRY.keys()].join(", ")})`);
  }
  return module;
}

export const sourceTypes = [...REGISTRY.keys()];
