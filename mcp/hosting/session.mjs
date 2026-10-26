export const defaults = {token:null,guestId:null,addressId:null,phone:null,paymentPref:null,data:{}};
export const session = {...defaults};
export function clearSession(){Object.assign(session,defaults);}
export function loadSession(value){Object.assign(session,defaults,value??{});}
export function exportSession(){return {...session};}

let persist=async()=>{};
export function setPersistenceHook(fn){persist=fn;}
export async function persistNow(){await persist();}
