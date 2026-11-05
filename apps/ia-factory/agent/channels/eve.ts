import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The factory runs on the developer's machine in v1, so the only principal it
 * sees is the local one. The shim defers the trust decision to `localDev()`,
 * returning `null` for anything it would reject, so it never affects a
 * production deployment.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local ? { ...local, principalType: "user" } : null;
};

export default eveChannel({ auth: [localDevUser] });
