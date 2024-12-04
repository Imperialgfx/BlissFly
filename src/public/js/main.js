document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('proxyForm');
    const input = form.querySelector('input');
    const warningTrigger = document.querySelector('.warning-trigger');
    const infoContent = document.querySelector('.info-content');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let url = input.value.trim();
        
        if (!url) {
            showError('Please enter a URL');
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        try {
            const encodedUrl = btoa(encodeURIComponent(url));
            window.location.href = '/watch?url=' + encodedUrl;
        } catch (error) {
            showError('Invalid URL format');
        }
    });

    warningTrigger.addEventListener('click', () => {
        warningTrigger.classList.toggle('active');
        infoContent.classList.toggle('active');
    });

    function showError(message) {
        const errorPopup = document.createElement('div');
        errorPopup.className = 'error-popup';
        errorPopup.textContent = message;
        document.body.appendChild(errorPopup);

        setTimeout(() => {
            errorPopup.remove();
        }, 3000);
    }

    // Focus input on load
    input.focus();
});
