import { send } from "./transport.js";
export class Worker {
  run(task) { return send(task); }
}
export const createWorker = () => new Worker();
