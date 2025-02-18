let audio = new Audio(); // 1つのオーディオインスタンスを作る

document.querySelectorAll('.soundButton').forEach(button => {
    button.addEventListener('click', function() {
        if (!audio.paused) {
            audio.pause();  // 再生中なら一旦停止
            audio.currentTime = 0; // 音の再生位置を最初に戻す
        }
        audio.src = this.dataset.sound;
        audio.play();
    });
});

// 音を止めるボタンの処理
document.getElementById('stopButton').addEventListener('click', function() {
    if (!audio.paused) {
        audio.pause();  // 音を停止
        audio.currentTime = 0; // 再生位置をリセット
    }
});
