function addDigit(char) {
    playSound();
    let element = document.getElementById('monitor');
    element.value += char;
    element.text += char;
    element.style.color = "white"
}
 function removeAllDigits() {
    playSound('clear');
    let element = document.getElementById('monitor');
    element.value = null;
    element.text = null;
 }

 function removeADigit(){
    playSound('discard');
    let element = document.getElementById('monitor');
    let exp = element.value;

    exp = exp.substring(0,exp.length - 1);

    element.value = exp;
    element.text = exp;
 }

 function evaluateExp() {
    let element = document.getElementById('monitor');
    try {
        let result = eval(element.value);
        element.value = result;
        element.text = result;
        element.style.color = "greenyellow"
        playSound('correct');
    } catch (error) {
        element.style.color = "red"
        playSound('error');
    }
    
 }
function playSound(selector){    
    let click = new Audio();

    switch (selector) {
        case 'error':
            click.src = './assets/sounds/error.mp3'
            click.play();
            break;
           
        case 'correct':
            click.src = './assets/sounds/correct.mp3'
            click.play();
            break;
        case 'discard':
            click.src = './assets/sounds/discard.mp3'
            click.play();
            break;
           
        case 'clear':
            click.src = './assets/sounds/clear.mp3'
            click.play();
            break;
        default:
            click.src = './assets/sounds/click.mp3'
            click.play();
            break;
    }
    
}
