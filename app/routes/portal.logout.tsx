/** Sign out — destroys the portal session cookie and returns to login. */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { destroyPortalSession } from "~/services/portal/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  return destroyPortalSession(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return destroyPortalSession(request);
}
