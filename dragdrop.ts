export function init() {
  let dropRegion = document.querySelector('#regl-canvas')!;
  dropRegion.addEventListener('dragenter', preventDefault, false);
  dropRegion.addEventListener('dragleave', preventDefault, false);
  dropRegion.addEventListener('dragover', preventDefault, false);
  dropRegion.addEventListener('drop', preventDefault, false);
  dropRegion.addEventListener('drop', handleDrop, false);
}

export let handlers = {
  ondrop: (url) => {},
}

function preventDefault(e) {
  e.preventDefault();
  e.stopPropagation();
}

function handleDrop(e) {
  let files = e.dataTransfer.files;
  if (files.length) {
    let reader = new FileReader();
    reader.onload = function(e) {
      if (e && e.target)
        handlers.ondrop(e.target.result as string);
    }
    reader.readAsDataURL(files[0]);    
  } else {
    let html = e.dataTransfer.getData('text/html');
    let match = html && /\bsrc="?([^"\s]+)"?\s*/.exec(html);
    let url = match && match[1];
    console.log("got url", url);
    handlers.ondrop(url);
  }
}