(function () {
  var track = document.getElementById('carouselTrack');
  var dotsEl = document.getElementById('carouselDots');
  var slides = track ? Array.prototype.slice.call(track.querySelectorAll('.carousel-slide')) : [];
  if (!track || !slides.length) return;

  var carousel = document.getElementById('screenshotCarousel');
  var prevBtn = carousel.querySelector('.carousel-btn.prev');
  var nextBtn = carousel.querySelector('.carousel-btn.next');
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightboxImg');
  var index = 0;

  slides.forEach(function (slide, i) {
    var dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.setAttribute('aria-label', 'Go to screenshot ' + (i + 1));
    dot.addEventListener('click', function () { goTo(i); });
    dotsEl.appendChild(dot);
  });
  var dots = Array.prototype.slice.call(dotsEl.querySelectorAll('.dot'));

  function goTo(i) {
    index = (i + slides.length) % slides.length;
    track.style.transform = 'translateX(calc(-' + index + ' * (100% + 20px)))';
    dots.forEach(function (dot, d) { dot.classList.toggle('active', d === index); });
    if (!lightbox.hidden) {
      lightboxImg.src = slides[index].querySelector('img').src;
      lightboxImg.alt = slides[index].querySelector('img').alt;
    }
  }

  prevBtn.addEventListener('click', function () { goTo(index - 1); });
  nextBtn.addEventListener('click', function () { goTo(index + 1); });
  goTo(0);

  slides.forEach(function (slide, i) {
    var img = slide.querySelector('img');
    img.addEventListener('click', function () { openLightbox(i); });
  });

  function openLightbox(i) {
    goTo(i);
    var img = slides[i].querySelector('img');
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.hidden = true;
    document.body.style.overflow = '';
  }

  lightbox.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lightbox.querySelector('.lightbox-btn.prev').addEventListener('click', function () { goTo(index - 1); });
  lightbox.querySelector('.lightbox-btn.next').addEventListener('click', function () { goTo(index + 1); });
  lightbox.addEventListener('click', function (e) {
    if (e.target === lightbox) closeLightbox();
  });

  document.addEventListener('keydown', function (e) {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') goTo(index - 1);
    if (e.key === 'ArrowRight') goTo(index + 1);
  });

  // Swipe support for the inline carousel
  var touchStartX = null;
  track.addEventListener('touchstart', function (e) { touchStartX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', function (e) {
    if (touchStartX === null) return;
    var delta = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 40) goTo(delta < 0 ? index + 1 : index - 1);
    touchStartX = null;
  });
})();
