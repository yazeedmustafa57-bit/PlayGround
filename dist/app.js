(() => {
  const clock = document.querySelector("[data-clock]");
  const date = document.querySelector("[data-date]");
  const greet = document.querySelector("[data-greet]");
  const message = document.querySelector("[data-message]");

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const greetings = [
    "Hello there — nice to meet you.",
    "Hey! The playground is all yours.",
    "Welcome in. Make something good.",
    "Hi! Everything is wired up and ready.",
  ];

  let next = 0;

  const renderTime = () => {
    const now = new Date();
    if (clock) clock.textContent = time.format(now);
    if (date) date.textContent = day.format(now);
  };

  renderTime();
  window.setInterval(renderTime, 1000);

  greet?.addEventListener("click", () => {
    if (message) {
      message.textContent = greetings[next % greetings.length];
      message.classList.add("is-live");
    }
    next += 1;
  });
})();
