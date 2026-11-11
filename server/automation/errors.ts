export class Pending extends Error {}
export class UnconfirmedStop extends Pending {}
export class EvaluationSliceYield extends Pending {}
export class FollowupRuntimeError extends Error {
  constructor(message:string,readonly nextSteps:string[]){super(message);}
}
/** A structural input failure cannot be repaired by replaying the same send. */
export class GenerationInputError extends FollowupRuntimeError {
  constructor(message:string){super(message,['调整任务资料载体或修复批次；上下文已满时先完成压缩或同站交接，再恢复原任务。']);}
}
