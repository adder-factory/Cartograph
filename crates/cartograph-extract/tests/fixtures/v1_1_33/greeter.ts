/** Service contract. */
export interface Greeter extends Base {
  greet(name: string): Promise<string>;
}

/** Greets users. */
export class Service implements Greeter {
  async greet(name: string): Promise<string> {
    return format(name);
  }
}

export const build = (service: Service) => service.greet("Ada");
