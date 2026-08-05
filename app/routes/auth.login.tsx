import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = (await login(request)) as Record<string, string> | null;
  return { errors: errors ?? {} };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = (await login(request)) as Record<string, string> | null;
  return { errors: errors ?? {} };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = actionData?.errors ?? loaderData.errors;

  return (
    <main style={{ fontFamily: "sans-serif", padding: "4rem", maxWidth: 480 }}>
      <h1>Log in — Cellexia Continuous Treatment</h1>
      <Form method="post">
        <label style={{ display: "block", marginBottom: 8 }}>
          Shop domain
          <input
            type="text"
            name="shop"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            placeholder="example.myshopify.com"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        {errors && "shop" in errors ? (
          <p style={{ color: "#b00020" }}>{String(errors.shop)}</p>
        ) : null}
        <button type="submit" style={{ padding: "8px 24px" }}>
          Log in
        </button>
      </Form>
    </main>
  );
}
