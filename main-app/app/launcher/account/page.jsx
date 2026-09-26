
import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import styles from "./account.module.css";
import PointsPanel from './PointsPanel';
import { pointsEnabled } from '@/lib/points';

export default async function AccountPage({ searchParams }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/launcher/sign-in");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "display_name, avatar_url, terms_version, privacy_version, accepted_terms_at, created_at"
    )
    .eq("id", user.id)
    .single();

  if (!profile) {
    redirect("/launcher/sign-in");
  }

  const displayName =
    profile.display_name ||
    user.email?.split("@")[0] ||
    "PlayLive User";

  const createdAt = new Date(
    profile.created_at
  ).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const emailVerified = Boolean(user.email_confirmed_at);
  const query = await searchParams;

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>PLAYLIVE</span>

            <h1>Account</h1>

            <p>
              Manage your PlayLive account and access your
              games.
            </p>
          </div>

          <Link
            href="/"
            className={styles.homeLink}
          >
            Back to website
          </Link>
        </header>

        <section className={styles.profileCard}>
          <div className={styles.avatar}>
            {displayName.charAt(0).toUpperCase()}
          </div>

          <div className={styles.profileInfo}>
            <h2>{displayName}</h2>

            <div className={styles.emailRow}>
              <span>{user.email}</span>

              {emailVerified && (
                <span className={styles.verified}>
                  ✓ Verified
                </span>
              )}
            </div>
          </div>
        </section>

        {pointsEnabled() && <PointsPanel supabase={supabase} userId={user.id} cursor={query?.pointsCursor ?? null} />}

        <div className={styles.grid}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <span className={styles.cardEyebrow}>
                  PROFILE
                </span>

                <h2>Account information</h2>
              </div>
            </div>

            <div className={styles.infoList}>
              <div className={styles.infoRow}>
                <span className={styles.label}>
                  Display name
                </span>

                <span className={styles.value}>
                  {displayName}
                </span>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.label}>
                  Email
                </span>

                <span className={styles.value}>
                  {user.email}
                </span>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.label}>
                  Email status
                </span>

                <span
                  className={
                    emailVerified
                      ? styles.statusVerified
                      : styles.statusPending
                  }
                >
                  {emailVerified
                    ? "Verified"
                    : "Verification required"}
                </span>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.label}>
                  Account created
                </span>

                <span className={styles.value}>
                  {createdAt}
                </span>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <span className={styles.cardEyebrow}>
                  CONNECTIONS
                </span>

                <h2>Connected services</h2>
              </div>
            </div>

            <div className={styles.serviceList}>
              <div className={styles.serviceRow}>
                <div>
                  <strong>Patreon</strong>
                  <span>
                    Connect your Patreon account later.
                  </span>
                </div>

                <span className={styles.notConnected}>
                  Not connected
                </span>
              </div>

              <div className={styles.serviceRow}>
                <div>
                  <strong>itch.io</strong>
                  <span>
                    Connect your itch.io account later.
                  </span>
                </div>

                <span className={styles.notConnected}>
                  Not connected
                </span>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <span className={styles.cardEyebrow}>
                  SUBSCRIPTION
                </span>

                <h2>Your plan</h2>
              </div>
            </div>

            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                —
              </div>

              <h3>No active plan</h3>

              <p>
                Your subscription information will appear
                here when you have an active plan.
              </p>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <span className={styles.cardEyebrow}>
                  LIBRARY
                </span>

                <h2>Owned games</h2>
              </div>
            </div>

            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                🎮
              </div>

              <h3>Your library is empty</h3>

              <p>
                Games you own will appear here once they
                are available.
              </p>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <span className={styles.cardEyebrow}>
                  SECURITY
                </span>

                <h2>Account security</h2>
              </div>
            </div>

            <div className={styles.actionList}>
              <Link
                href="/launcher/forgot-password"
                className={styles.actionButton}
              >
                <span>
                  <strong>Manage password</strong>
                  <small>
                    Change or reset your password
                  </small>
                </span>

                <span className={styles.arrow}>
                  →
                </span>
              </Link>

              <form
                action="/api/auth/sign-out"
                method="POST"
              >
                <button
                  type="submit"
                  className={styles.signOut}
                >
                  Sign out
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

