document.querySelectorAll('.soundButton').forEach(button => {
    button.addEventListener('click', function() {
        let audio = document.getElementById('audioPlayer');
        audio.src = this.dataset.sound;
        audio.play();
    });
});

// 音を止めるボタンの処理
document.getElementById('stopButton').addEventListener('click', function() {
    let audio = document.getElementById('audioPlayer');
    audio.pause();  // 再生を一時停止
    audio.currentTime = 0; // 音の再生位置を最初に戻す
});