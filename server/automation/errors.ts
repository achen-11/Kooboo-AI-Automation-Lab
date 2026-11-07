export class Pending extends Error {}
export class UnconfirmedStop extends Pending {}
export class FollowupRuntimeError extends Error {
  constructor(message:string,readonly nextSteps:string[]){super(message);}
}
