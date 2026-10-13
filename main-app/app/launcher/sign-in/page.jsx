"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/client";
import styles from "./sign-in.module.css";

function getSafeReturnTo(value) {
if (typeof value !== "string" || !value) {
return "/launcher/account";
}

try {
const url = new URL(value, window.location.origin);

// Only allow same-origin relative paths.
if (url.origin !== window.location.origin) {
  return "/launcher/account";
}

// The launcher authorization flow must return to this route.
if (!["/launcher/authorize", "/launcher/points", "/launcher/points/claim"].includes(url.pathname)) {
  return "/launcher/account";
}

return `${url.pathname}${url.search}${url.hash}`;


} catch {
return "/launcher/account";
}
}

export default function SignInPage() {
const router = useRouter();
const searchParams = useSearchParams();
const supabase = createClient();

const [form, setForm] = useState({
email: "",
password: "",
});

const [loading, setLoading] = useState(false);
const [resending, setResending] = useState(false);
const [error, setError] = useState("");
const [message, setMessage] = useState("");

const verified = searchParams.get("verified") === "true";
const returnTo = searchParams.get("returnTo");

useEffect(() => {
if (verified) {
setMessage(
"Your email has been verified successfully. You can now sign in."
);
}
}, [verified]);

function handleChange(event) {
const { name, value } = event.target;


setForm((current) => ({
  ...current,
  [name]: value,
}));


}

async function handleSubmit(event) {
event.preventDefault();


if (loading) return;

setError("");
setMessage("");

if (!form.email.trim()) {
  setError("Please enter your email address.");
  return;
}

if (!form.password) {
  setError("Please enter your password.");
  return;
}

try {
  setLoading(true);

  const { data, error: signInError } =
    await supabase.auth.signInWithPassword({
      email: form.email.trim(),
      password: form.password,
    });

  if (signInError) {
    console.error("SUPABASE SIGN IN ERROR:", signInError);

    setError(
      "We couldn't sign you in. Please check your email and password."
    );
    return;
  }

  if (!data?.user) {
    setError("We couldn't complete the sign-in. Please try again.");
    return;
  }

  if (!data.user.email_confirmed_at) {
    setError(
      "Please verify your email address before signing in."
    );
    return;
  }

  const safeReturnTo = getSafeReturnTo(returnTo);

  router.push(safeReturnTo);
  router.refresh();
} catch (err) {
  console.error("SIGN IN ERROR:", err);

  setError("Something went wrong. Please try again.");
} finally {
  setLoading(false);
}


}

async function handleResendVerification() {
if (resending) return;


setError("");
setMessage("");

const normalizedEmail = form.email.trim().toLowerCase();

if (!normalizedEmail) {
  setError("Enter your email address first.");
  return;
}

try {
  setResending(true);

  const { error: resendError } =
    await supabase.auth.resend({
      type: "signup",
      email: normalizedEmail,
      options: {
        emailRedirectTo:
          `${window.location.origin}/launcher/success`,
      },
    });

  if (resendError) {
    console.error(
      "SUPABASE RESEND ERROR:",
      resendError
    );

    setError(
      `${resendError.message} (${
        resendError.code ||
        resendError.status ||
        "unknown"
      })`
    );

    return;
  }

  setMessage(
    "If your account is eligible for verification, a new email has been sent. Please check your inbox and spam folder."
  );
} catch (err) {
  console.error(
    "RESEND VERIFICATION ERROR:",
    err
  );

  setError(
    "Something went wrong. Please try again later."
  );
} finally {
  setResending(false);
}


}

return ( <main className={styles.page}> <section className={styles.card}> <div className={styles.header}> <span className={styles.eyebrow}>PLAYLIVE</span>


      <h1>Welcome back</h1>

      <p>
        Sign in to your PlayLive account to access your
        games and launcher.
      </p>
    </div>

    {message && (
      <div className={styles.success} role="status">
        {message}
      </div>
    )}

    {error && (
      <div className={styles.error} role="alert">
        {error}
      </div>
    )}

    <form onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label htmlFor="email">Email address</label>

        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={handleChange}
          disabled={loading}
          placeholder="you@example.com"
        />
      </div>

      <div className={styles.field}>
        <div className={styles.passwordHeader}>
          <label htmlFor="password">Password</label>

          <Link
            href="/launcher/forgot-password"
            className={styles.forgot}
          >
            Forgot password?
          </Link>
        </div>

        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={form.password}
          onChange={handleChange}
          disabled={loading}
          placeholder="Your password"
        />
      </div>

      <button
        type="submit"
        className={styles.button}
        disabled={loading}
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>
    </form>

    <button
      type="button"
      className={styles.resend}
      onClick={handleResendVerification}
      disabled={resending}
    >
      {resending
        ? "Sending..."
        : "Resend verification email"}
    </button>

    <p className={styles.footer}>
      Don't have an account?{" "}
      <Link href="/launcher/register">
        Create one
      </Link>
    </p>
  </section>
</main>


);
}
