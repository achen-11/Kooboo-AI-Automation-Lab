import { Pending } from '../errors.js';
export class CollectionPending extends Pending {
  readonly name='CollectionPending'; readonly safeToRetry=true;
  constructor(message:string,readonly progressKey:string,readonly waiting=false,readonly nextAt=Date.now()+3000){super(message);}
}
export class CollectionBlocked extends Pending {
  readonly name='CollectionBlocked';
  constructor(message:string,readonly nextSteps:string[]){super(message);}
}
