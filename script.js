document.querySelectorAll('.soundButton').forEach(button => {
    button.addEventListener('click', function() {
        let audio = document.getElementById('audioPlayer');
        audio.src = this.dataset.sound;
        audio.play();
    });
});
