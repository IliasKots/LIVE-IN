"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/app/games.module.css";
import { motion, useAnimation } from "framer-motion";
import { useInView } from "react-intersection-observer";

// 1. ADDED THE 'url' FIELD TO EACH GAME OBJECT
const games = [
  {
    image: "/tower-battle.png",
    title: "Tower Battle",
    category: "Reaction game",
    description:
      "A fast viewer-controlled tower battle that gets your audience choosing sides, reacting, and fighting to reach 500 points first.",
    url: "https://tiktok-live-games.itch.io/tower-battle-tiktok-live-interactive-game-customizable", 
  },
  {
    image: "/flag-rush.png",
    title: "Flag Rush",
    category: "TikTok LIVE Racing",
    description:
      "A fast viewer-controlled race where gifts power your runners, viewers choose their countries, and every LIVE can become a photo finish.",
    url: "https://tiktok-live-games.itch.io/racing-tiktok-live-game", 
  },
  {
    image: "/disco.png",
    title: "Disco",
    category: "TikTok LIVE Dancing",
    description:
      "A neon TikTok LIVE nightclub where viewers become dancers, gifts unlock VIP moments, and every stream turns into an interactive party.",
    url: "https://tiktok-live-games.itch.io/disco-tiktok-live-game", 
  },
  {
    image: "/SquidGame.png",
    title: "Red Green Light",
    category: "Reaction game",
    description:
      "A fast viewer-controlled challenge that keeps people watching, reacting, and waiting for the next round.",
    url: "https://tiktok-live-games.itch.io/tiktok-live-games", 
  },
  {
    image: "/score_goal.png",
    title: "World-Cup",
    category: "Team Battle",
    description:
      "Turn Your TikTok LIVE Into an Interactive FIFA World Cup Experience ⚽",
    url: "https://tiktok-live-games.itch.io/worldcup-tiktok-live-game",
  },
  {
    image: "/tiktok_live_games_bundle.png",
    title: "TikTok Live Games Bundle",
    category: "Bundle",
    imageMode: "contain",
    description:
      "Get access to all 5 TikTok LIVE games in one bundle and let your audience interact through likes, comments, and gifts.",
    url: "https://tiktok-live-games.itch.io/tiktok-live-interactive-games",
  },
    {
    image: "/Ping Pong.png",
    title: "Shooting Battle",
    category: "PvP arena",
    imageMode: "contain",
    description:
      "Red versus Blue chaos where viewers join teams and fight live through TikTok interactions.",
    url: "https://tiktok-live-games.itch.io/new-tiktok-live-game",
  },
  {
    image: "/driverush.png",
    title: "Drive Rush",
    category: "Car Racing",
    description:
      "DriveRush turns your TikTok LIVE into an interactive racing game where viewers control the action.",
    url: "https://tiktok-live-games.itch.io/tiktok-live-game-driverush",
  },
  {
    image: "/football_modern.png",
    title: "Score Goal",
    category: "Team battle",
    description:
      "Viewers choose sides, push their team forward, and turn every goal attempt into a LIVE moment.",
    url: "https://iliaskot.itch.io/tiktok-live-game-score-goal",
  },
  {
    image: "/space_modern.png",
    title: "Spacecrafts Race",
    category: "Gift Race",
    description:
      "Viewers move the spacecrafts by sending gifts, but you can also control them manually.",
    url: "https://tiktok-live-games.itch.io/tiktok-live-interactive-game-spacecrafts-race",
  },
  {
    title: "Mystery Game",
    category: "Secret drop",
    isMystery: true,
    description:
      "A hidden interactive game is included in the bundle. Buy access and discover it inside the library.",
    url: "#pricing", // Keeps the mystery card scrolling down to your section
  },
  
];

const sectionVariants = {
  hidden: { opacity: 0, y: 45 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.65,
      ease: "easeOut",
      staggerChildren: 0.08,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 28 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: "easeOut" },
  },
};

const Games = () => {
  const controls = useAnimation();
  const trackRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const [ref, inView] = useInView({
    threshold: 0.18,
    triggerOnce: false,
  });

  useEffect(() => {
    controls.start(inView ? "visible" : "hidden");
  }, [controls, inView]);

  const updateScrollButtons = () => {
    const track = trackRef.current;
    if (!track) return;

    const maxScrollLeft = track.scrollWidth - track.clientWidth;
    setCanScrollLeft(track.scrollLeft > 8);
    setCanScrollRight(track.scrollLeft < maxScrollLeft - 8);
  };

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    updateScrollButtons();
    track.addEventListener("scroll", updateScrollButtons, { passive: true });
    window.addEventListener("resize", updateScrollButtons);

    return () => {
      track.removeEventListener("scroll", updateScrollButtons);
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, []);

  const scrollGames = (direction) => {
    const track = trackRef.current;
    if (!track) return;

    track.scrollBy({
      left: direction * Math.min(track.clientWidth * 0.85, 720),
      behavior: "smooth",
    });
  };

  return (
    <motion.section
      id="games"
      ref={ref}
      className={styles.gamesSection}
      variants={sectionVariants}
      initial="hidden"
      animate={controls}
    >
      <div className={styles.gamesPanel}>
        <div className={styles.blurOrbOne} />
        <div className={styles.blurOrbTwo} />

        <div className={styles.gamesContainer}>
          <div className={styles.headerRow}>
            <motion.div className={styles.headerCopy} variants={itemVariants}>
              <span className={styles.sectionLabel}>🎮 Games Library</span>
              <h2 className={styles.gamesTitle}>
                Pick a game. Let your viewers run the show.
              </h2>
              <p className={styles.gamesSubtitle}>
                Swipe through the Live In game library and choose the experience
                that fits your next TikTok LIVE.
              </p>
            </motion.div>

            <motion.div className={styles.controls} variants={itemVariants}>
              <button
                type="button"
                className={styles.arrowButton}
                onClick={() => scrollGames(-1)}
                disabled={!canScrollLeft}
                aria-label="Previous games"
              >
                ←
              </button>
              <button
                type="button"
                className={styles.arrowButton}
                onClick={() => scrollGames(1)}
                disabled={!canScrollRight}
                aria-label="Next games"
              >
                →
              </button>
            </motion.div>
          </div>

          <motion.div className={styles.carouselShell} variants={itemVariants}>
            <div className={styles.carouselTrack} ref={trackRef}>
              {games.map((game, index) => (
                <motion.article
                  className={`${styles.gameCard} ${game.isMystery ? styles.mysteryCard : ""}`}
                  key={`${game.title}-${index}`}
                  variants={itemVariants}
                  whileTap={{ scale: 0.97 }}
                >
                  {/* 2. DYNAMICALLY UPDATED LINK AND TARGET ENTRIES HERE */}
                  <a 
                    className={styles.cardLink} 
                    href={game.url}
                    target={game.url.startsWith("http") ? "_blank" : undefined}
                    rel={game.url.startsWith("http") ? "noopener noreferrer" : undefined}
                  >
                    <div className={styles.cardTopRow}>
                      <span className={styles.cardNumber}>
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className={styles.cardCategory}>{game.category}</span>
                    </div>

                    {game.isMystery ? (
                      <div className={styles.mysteryWrap}>
                        <div className={styles.mysteryGlow} />
                        <div className={styles.mysteryRing} />
                        <div className={styles.mysteryQuestion}>?</div>
                        <span className={styles.mysteryText}>Unlock to reveal</span>
                      </div>
                    ) : (
                      <div
                        className={`${styles.imageWrap} ${
                          game.imageMode === "contain" ? styles.imageContain : ""
                        }`}
                      >
                        {game.imageMode === "contain" && (
                          <img
                            src={game.image}
                            alt=""
                            aria-hidden="true"
                            className={styles.imageBackdrop}
                          />
                        )}
                        <img
                          src={game.image}
                          alt={game.title}
                          className={styles.gameImage}
                        />
                      </div>
                    )}

                    <div className={styles.cardBody}>
                      <h3>{game.title}</h3>
                      <p>{game.description}</p>
                    </div>

                    <div className={styles.cardFooter}>
                     {/* CHANGED "Included" TO "Official Store" FOR CLARITY */}
                      <span>{game.isMystery ? "Hidden bonus" : "Official Store"}</span>
  
                      {/* CHANGED "View on itch.io" TO "Buy on itch.io" TO INSTANTLY SIGNAL A TRANSACTION */}
                      <strong>{game.isMystery ? "Reveal now →" : "Buy on itch.io →"}</strong>
</div>
                  </a>
                </motion.article>
              ))}
            </div>
          </motion.div>

          <motion.div className={styles.bottomBar} variants={itemVariants}>
            <p>More games can be added to this library as your offer grows.</p>
            <a href="#pricing">Unlock the library</a>
          </motion.div>
        </div>
      </div>
    </motion.section>
  );
};

export default Games;