// Esqueleto para el commit rojo: las pruebas deben fallar por aserción.
const pending=()=>{throw new Error('NOT_IMPLEMENTED: autorización de bootstrap pendiente');};
export const requestBootstrap=pending,bootstrapStatus=pending,bootstrapAuthorized=()=>false;
