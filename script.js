document.addEventListener("DOMContentLoaded", function() {
    let theWheel = new Winwheel({
        'canvasId'   : 'canvas',
        'numSegments': 6,
        'outerRadius': 150,
        'segments': [
            {'fillStyle' : '#eae56f', 'text' : 'Prize 1'},
            {'fillStyle' : '#89f26e', 'text' : 'Prize 2'},
            {'fillStyle' : '#7de6ef', 'text' : 'Prize 3'},
            {'fillStyle' : '#eae56f', 'text' : 'Prize 4'},
            {'fillStyle' : '#89f26e', 'text' : 'Prize 5'},
            {'fillStyle' : '#7de6ef', 'text' : 'Prize 6'},
            // Add more as needed
        ],
        'animation': {
            'type'     : 'spinToStop',
            'duration' : 5,
            'spins'    : 8,
            'callbackFinished': alertPrize
        }
    });

    let button = document.getElementById('spinButton');
    button.addEventListener('click', function() {
        theWheel.startAnimation();
    });

    function alertPrize(indicatedSegment) {
        // Do something when the animation has finished
        alert("The wheel stopped at: " + indicatedSegment.text);
    }
});