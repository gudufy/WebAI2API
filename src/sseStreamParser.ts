export interface SSEvent {
    event: string;
    data: any;
    rawData: string;   // 原始data文本，未解析成JSON的形式
}

/**
 * SSE流解析器，支持增量解析和事件类型识别
 */
export class SseStreamParser {
    buffer: string = "";

    static parseBlock(block: string): SSEvent | null {
        const trimmed = block.trim();
        if (!trimmed) return null;

        let eventName = 'message';  // SSE缺省事件类型为 'message'
        const dataLines: string[] = [];
        const lines = block.split('\n');

        for (const line of lines) {
            if (!line || line.startsWith(':')) continue;    // 以冒号开头的是注释

            if (line.startsWith('event:')) {
                eventName = line.slice('event:'.length).trim();
                continue;
            }

            if (line.startsWith('data:')) {
                const value = line.slice('data:'.length);
                // 只去掉1个可选分隔空格，避免破坏正文内容
                dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
            }
        }

        const dataText = dataLines.join('\n');
        let data = dataText;
        if (dataText) {
            try {
                data = JSON.parse(dataText);
            } catch {
                data = dataText;
            }
        }
        return { event: eventName, data, rawData: dataText };
    }

    /**
     * 接收一段文本块，解析出完整的事件并返回，剩余不完整的部分保存在内部缓冲区
     */
    push(chunk: string): Array<SSEvent> {
        if (chunk === null || chunk === undefined || chunk === '') return [];

        // 归一化换行。逐 chunk 替换会漏掉跨 chunk 的 "\r" + "\n" 边界，
        // 因此先拼接原始内容，再统一替换；末尾残留的 \r 留到下一块一起处理。
        this.buffer += String(chunk);
        const pendingCr = this.buffer.endsWith('\r') ? '\r' : '';
        this.buffer = this.buffer.slice(0, this.buffer.length - pendingCr.length).replace(/\r\n?/g, '\n') + pendingCr;
        const events: SSEvent[] = [];

        let separatorIndex = this.buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
            const block = this.buffer.slice(0, separatorIndex);
            this.buffer = this.buffer.slice(separatorIndex + 2);
            const event = SseStreamParser.parseBlock(block);
            if (event) events.push(event);
            separatorIndex = this.buffer.indexOf('\n\n');
        }

        return events;
    }

    /**
     * 收尾，解析剩余缓冲区中的事件，并清空缓冲区
     * 使用push一定要配合finish
     */
    finish(): Array<SSEvent> {
        const tail = this.buffer.trim();
        this.buffer = '';
        if (!tail) return [];
        const event = SseStreamParser.parseBlock(tail);
        return event ? [event] : [];
    }

    /**
     * 一次性解析全部文本，适用于已经完整获取到SSE数据的场景
     */
    parseAll(raw: string): Array<SSEvent> {
        const normalized = raw.replace(/\r\n/g, '\n');
        const blocks = normalized.split('\n\n');
        const events: SSEvent[] = [];
        for (const block of blocks) {
            const event = SseStreamParser.parseBlock(block);
            if (event) events.push(event);
        } return events;
    }
}
