/**
 * Automatically resizes a textarea element to fit its content
 * @param textareaElement - The textarea element to resize
 */
export default function autoResizeTextarea(textareaElement: HTMLTextAreaElement | null): void {
	if (textareaElement && !(typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'))) {
		textareaElement.style.height = '1rem';
		textareaElement.style.height = textareaElement.scrollHeight + 'px';
	}
}
