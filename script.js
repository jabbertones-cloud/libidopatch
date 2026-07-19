const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#site-nav");

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  navigation?.classList.toggle("open", open);
});

navigation?.addEventListener("click", () => {
  menuButton?.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
});

const checkoutSucceeded = new URLSearchParams(window.location.search).get("checkout") === "success";
const successBanner = document.querySelector(".success-banner");
if (checkoutSucceeded && successBanner) {
  successBanner.hidden = false;
  successBanner.scrollIntoView({ block: "start" });
}

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());
